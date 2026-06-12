'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

const STALE_KICK_MS = 3 * 60 * 1000

function scanNeedsContinuation(data: ScanProgress): boolean {
  if (data.status === 'cancelled') return false
  if (data.action_type) return false
  if (data.status === 'error' && data.phase.includes('resume')) return true
  if (data.status !== 'scanning' && data.status !== 'error') return false
  if (data.list_complete === false) return true
  const checkpoint = Math.max(data.cursor ?? 0, data.scanned ?? 0)
  if (data.total > 0 && checkpoint < data.total) return true
  if (data.phase.toLowerCase().includes('fetching email list')) return true
  if (data.phase.toLowerCase().includes('rebuilding email list')) return true
  return false
}

export function canContinueScan(data: ScanProgress): boolean {
  if (data.status === 'cancelled' || data.status === 'complete') return false
  const checkpoint = Math.max(data.cursor ?? 0, data.scanned ?? 0)
  if (data.total <= 0 || checkpoint >= data.total) return false
  if (data.status === 'scanning') return true
  if (data.status === 'error' && data.phase.includes('resume')) return true
  return false
}

function isProgressStale(data: ScanProgress): boolean {
  if (!data.updated_at) return true
  return Date.now() - new Date(data.updated_at).getTime() > STALE_KICK_MS
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

  const requestChunk = useCallback(async (opts?: StartScanOptions) => {
    if (chunkInFlight.current) return
    chunkInFlight.current = true
    const gen = scanGeneration.current
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      })
      if (gen !== scanGeneration.current) return

      const data = await res.json().catch(() => ({}))
      if (data.error === 'gmail_auth_expired') {
        onAuthExpired?.()
      }
    } catch {
      // Cron / stale kick will recover stalled scans.
    } finally {
      chunkInFlight.current = false
    }
  }, [onAuthExpired])

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress')
      if (!res.ok) return
      const data: ScanProgress = await res.json()

      // The job row currently belongs to a bulk action, not a scan (e.g. the
      // scan request was skipped because an action holds the lock). Reset any
      // optimistic scanning state instead of rendering action progress as a scan.
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

      if (
        scanNeedsContinuation(data) &&
        isProgressStale(data) &&
        !chunkInFlight.current
      ) {
        const kickOpts = data.status === 'error' || isResumeRun.current ? { resume: true } : {}
        void requestChunk(kickOpts)
      }

      if (data.status === 'complete') {
        const wasActive = activeRef.current
        activeRef.current = false
        setIsScanning(false)
        setIsPaused(false)
        stopPolling()
        if (wasActive) onComplete?.()
      } else if (data.status === 'error' && !data.phase.includes('resume')) {
        activeRef.current = false
        setIsScanning(false)
        stopPolling()
        if (data.phase === 'Gmail access expired') {
          onAuthExpired?.()
          return
        }
        setScanError(true)
      } else if (data.status === 'scanning' && scanNeedsContinuation(data)) {
        setIsScanning(true)
        setScanError(false)
      }
    } catch {
      // keep polling
    }
  }, [onComplete, onAuthExpired, requestChunk, stopPolling])

  const beginPolling = useCallback(() => {
    if (pollRef.current) return
    void pollProgress()
    pollRef.current = setInterval(() => { void pollProgress() }, pollMs)
  }, [pollMs, pollProgress])

  const startScan = useCallback((opts: StartScanOptions = {}) => {
    scanGeneration.current += 1
    isResumeRun.current = !!opts.resume
    activeRef.current = true
    setIsScanning(true)
    setIsPaused(false)
    setScanError(false)
    setProgress({
      status: 'scanning',
      phase: opts.resume ? 'Resuming scan...' : 'Connecting to Gmail...',
      scanned: progress.scanned,
      total: progress.total,
    })
    stopPolling()
    void requestChunk(opts)
    beginPolling()
  }, [beginPolling, requestChunk, stopPolling, progress.scanned, progress.total])

  const cancelScan = useCallback(async () => {
    activeRef.current = false
    scanGeneration.current += 1
    stopPolling()
    setIsScanning(false)
    setIsPaused(false)
    try {
      const res = await fetch('/api/scan/cancel', { method: 'POST' })
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
      const res = await fetch('/api/scan/progress')
      if (!res.ok) return
      const data: ScanProgress = await res.json()

      // A bulk action owns the job row — nothing scan-related to resume.
      if (data.action_type) return

      setProgress(data)

      if (data.status === 'complete' || data.status === 'cancelled') {
        setIsScanning(false)
        setIsPaused(false)
        return
      }

      if (scanNeedsContinuation(data)) {
        setIsScanning(true)
        setScanError(false)
        beginPolling()
        if (isProgressStale(data)) {
          void requestChunk({ resume: true })
        }
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
