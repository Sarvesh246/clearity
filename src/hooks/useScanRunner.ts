'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { hasIncompleteScan } from '@/lib/scan/scanState'
import type { ScanProgress } from '@/types'

interface UseScanRunnerOptions {
  onComplete?: () => void
  onAuthExpired?: () => void
  pollMs?: number
}

export interface StartScanOptions {
  full?: boolean
  resume?: boolean
}

type ChunkSource = 'user' | 'background'

const STALE_KICK_MS = 3 * 60 * 1000

function scanNeedsContinuation(data: ScanProgress): boolean {
  if (data.status === 'cancelled') return false
  if (data.action_type) return false
  if (data.status === 'error' && data.phase.includes('will resume automatically')) return true
  if (data.status !== 'scanning' && data.status !== 'error') return false
  if (data.list_complete === false) return true
  const checkpoint = data.cursor ?? 0
  if (data.total > 0 && checkpoint < data.total) return true
  if (data.phase.toLowerCase().includes('fetching email list')) return true
  if (data.phase.toLowerCase().includes('rebuilding email list')) return true
  return false
}

export function canContinueScan(data: ScanProgress): boolean {
  if (data.status === 'complete') return false
  if (!hasIncompleteScan(data)) return false
  if (data.status === 'scanning') return true
  if (data.status === 'error' && data.phase.includes('will resume automatically')) return true
  if (data.status === 'cancelled') return true
  return false
}

function isProgressStale(data: ScanProgress): boolean {
  if (!data.updated_at) return true
  return Date.now() - new Date(data.updated_at).getTime() > STALE_KICK_MS
}

function isAutoResumingError(data: ScanProgress): boolean {
  return data.status === 'error' && data.phase.includes('will resume automatically')
}

export function useScanRunner(options: UseScanRunnerOptions = {}) {
  const { onComplete, onAuthExpired, pollMs = 2000 } = options
  const [isScanning, setIsScanning] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState<ScanProgress>({
    status: 'idle',
    phase: '',
    scanned: 0,
    total: 0,
  })
  const [scanError, setScanError] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const chunkInFlight = useRef(false)
  const pendingUserChunk = useRef<StartScanOptions | null>(null)
  const resumedRef = useRef(false)
  const activeRef = useRef(false)
  const scanGeneration = useRef(0)
  const isResumeRun = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress', { cache: 'no-store' })
      if (!res.ok) return
      const data: ScanProgress = await res.json()

      if (data.action_type) {
        activeRef.current = false
        setIsScanning(false)
        setIsPaused(false)
        stopPolling()
        return
      }

      setProgress(data)

      if (data.status === 'cancelled') {
        activeRef.current = false
        setIsScanning(false)
        setIsPaused(false)
        stopPolling()
        return
      }

      setIsPaused(false)

      if (data.status === 'complete') {
        const wasActive = activeRef.current
        activeRef.current = false
        setIsScanning(false)
        setIsPaused(false)
        stopPolling()
        if (wasActive) onComplete?.()
      } else if (data.status === 'error' && !isAutoResumingError(data)) {
        activeRef.current = false
        setIsScanning(false)
        stopPolling()
        if (data.phase === 'Gmail access expired') {
          onAuthExpired?.()
          return
        }
        setScanError(true)
      } else if (
        (data.status === 'scanning' || isAutoResumingError(data)) &&
        scanNeedsContinuation(data)
      ) {
        setIsScanning(true)
        setScanError(false)
      }
    } catch {
      // keep polling
    }
  }, [onComplete, onAuthExpired, stopPolling])

  const requestChunk = useCallback(async (
    opts?: StartScanOptions,
    source: ChunkSource = 'background'
  ) => {
    if (chunkInFlight.current) {
      if (source === 'user') pendingUserChunk.current = opts ?? {}
      return
    }

    chunkInFlight.current = true
    const gen = scanGeneration.current
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
        cache: 'no-store',
      })
      if (gen !== scanGeneration.current) return

      const data = await res.json().catch(() => ({}))
      if (data.error === 'gmail_auth_expired') {
        onAuthExpired?.()
        return
      }

      // Sync UI with server-written error / progress state immediately.
      await pollProgress()

      if (!res.ok && activeRef.current && data.error && data.continued === false) {
        setScanError(true)
        setIsScanning(false)
        activeRef.current = false
      }
    } catch {
      await pollProgress()
    } finally {
      chunkInFlight.current = false
      const pending = pendingUserChunk.current
      if (pending) {
        pendingUserChunk.current = null
        void requestChunk(pending, 'user')
      }
    }
  }, [onAuthExpired, pollProgress])

  const pollProgressWithKick = useCallback(async () => {
    await pollProgress()

    // Read latest progress via a fresh fetch for stale-kick decisions — pollProgress
    // updates React state asynchronously so we can't rely on closure values here.
    try {
      const res = await fetch('/api/scan/progress', { cache: 'no-store' })
      if (!res.ok) return
      const data: ScanProgress = await res.json()
      if (data.action_type) return

      if (
        scanNeedsContinuation(data) &&
        isProgressStale(data) &&
        !chunkInFlight.current
      ) {
        const kickOpts = data.status === 'error' || isResumeRun.current
          ? { resume: true }
          : {}
        void requestChunk(kickOpts, 'background')
      }
    } catch {
      // ignore
    }
  }, [pollProgress, requestChunk])

  const beginPolling = useCallback(() => {
    if (pollRef.current) return
    void pollProgressWithKick()
    pollRef.current = setInterval(() => { void pollProgressWithKick() }, pollMs)
  }, [pollMs, pollProgressWithKick])

  const startScan = useCallback((opts: StartScanOptions = {}) => {
    scanGeneration.current += 1
    isResumeRun.current = !!opts.resume
    activeRef.current = true
    setIsScanning(true)
    setIsPaused(false)
    setScanError(false)
    setProgress(prev => ({
      status: 'scanning',
      phase: opts.resume ? 'Resuming scan...' : 'Connecting to Gmail...',
      scanned: prev.scanned,
      total: prev.total,
      cursor: prev.cursor,
      list_complete: prev.list_complete,
    }))
    stopPolling()
    void requestChunk(opts, 'user')
    beginPolling()
  }, [beginPolling, requestChunk, stopPolling])

  const cancelScan = useCallback(async () => {
    activeRef.current = false
    scanGeneration.current += 1
    pendingUserChunk.current = null
    stopPolling()
    setIsScanning(false)
    setIsPaused(false)
    try {
      const res = await fetch('/api/scan/cancel', {
        method: 'POST',
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      setProgress(prev => ({
        ...prev,
        status: 'cancelled',
        phase: data.senderCount > 0
          ? `Stopped — ${Number(data.senderCount).toLocaleString()} senders saved and ready to review`
          : 'Scan cancelled',
      }))
    } catch {
      setProgress(prev => ({ ...prev, status: 'cancelled', phase: 'Scan cancelled' }))
    }
    onComplete?.()
  }, [onComplete, stopPolling])

  const resumeIfNeeded = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress', { cache: 'no-store' })
      if (!res.ok) return
      const data: ScanProgress = await res.json()

      if (data.action_type) return

      setProgress(data)

      if (data.status === 'complete' || data.status === 'cancelled') {
        setIsScanning(false)
        setIsPaused(false)
        if (data.status === 'cancelled') setProgress(data)
        return
      }

      if (scanNeedsContinuation(data)) {
        setIsScanning(true)
        setScanError(false)
        beginPolling()
        if (isProgressStale(data)) {
          void requestChunk({ resume: true }, 'background')
        }
      } else if (data.status === 'error' && !isAutoResumingError(data)) {
        setScanError(true)
      }
    } catch {
      // ignore
    }
  }, [beginPolling, requestChunk])

  useEffect(() => {
    if (resumedRef.current) return
    resumedRef.current = true
    void resumeIfNeeded()
    return () => {
      activeRef.current = false
      pendingUserChunk.current = null
      stopPolling()
    }
  }, [resumeIfNeeded, stopPolling])

  return {
    isScanning,
    isPaused,
    canContinue: canContinueScan(progress),
    progress,
    scanError,
    startScan,
    cancelScan,
    setScanError,
  }
}
