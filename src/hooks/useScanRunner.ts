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

function scanNeedsContinuation(data: ScanProgress): boolean {
  if (data.status === 'error' && data.phase.includes('resume')) return true
  if (data.status !== 'scanning') return false
  if (data.list_complete === false) return true
  if (data.total > 0 && data.scanned < data.total) return true
  if (data.phase.toLowerCase().includes('fetching email list')) return true
  return false
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
      if (data.continued && activeRef.current && gen === scanGeneration.current) {
        const nextOpts = isResumeRun.current ? { resume: true } : {}
        setTimeout(() => { void requestChunk(nextOpts) }, 300)
      }
    } catch {
      if (activeRef.current && gen === scanGeneration.current) {
        const nextOpts = isResumeRun.current ? { resume: true } : {}
        setTimeout(() => { void requestChunk(nextOpts) }, 3000)
      }
    } finally {
      chunkInFlight.current = false
    }
  }, [])

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress')
      if (!res.ok) return
      const data: ScanProgress = await res.json()
      setProgress(data)

      if (data.status === 'cancelled') {
        setIsPaused(true)
        if (!activeRef.current) {
          setIsScanning(false)
          stopPolling()
        }
        return
      }

      setIsPaused(false)

      if (scanNeedsContinuation(data) && activeRef.current) {
        void requestChunk(data.status === 'error' ? { resume: true } : {})
      }

      if (data.status === 'complete') {
        activeRef.current = false
        setIsScanning(false)
        setIsPaused(false)
        stopPolling()
        onComplete?.()
      } else if (data.status === 'error' && !data.phase.includes('resume')) {
        activeRef.current = false
        setIsScanning(false)
        stopPolling()
        if (data.phase === 'Gmail access expired') {
          onAuthExpired?.()
          return
        }
        setScanError(true)
      } else if (data.status === 'scanning') {
        setIsScanning(true)
        setScanError(false)
      }
    } catch {
      // keep polling
    }
  }, [onComplete, onAuthExpired, requestChunk, stopPolling])

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
    pollRef.current = setInterval(() => { void pollProgress() }, pollMs)
  }, [pollMs, pollProgress, requestChunk, stopPolling, progress.scanned, progress.total])

  const cancelScan = useCallback(async () => {
    activeRef.current = false
    scanGeneration.current += 1
    await fetch('/api/scan/cancel', { method: 'POST' }).catch(() => {})
    setIsScanning(false)
    setIsPaused(true)
    stopPolling()
  }, [stopPolling])

  const resumeIfNeeded = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress')
      if (!res.ok) return
      const data: ScanProgress = await res.json()
      setProgress(data)

      if (data.status === 'cancelled') {
        setIsPaused(true)
        return
      }

      if (scanNeedsContinuation(data) || data.status === 'error') {
        activeRef.current = true
        setIsScanning(true)
        setScanError(false)
        void requestChunk(data.status === 'error' ? { resume: true } : {})
        if (!pollRef.current) {
          pollRef.current = setInterval(() => { void pollProgress() }, pollMs)
        }
      }
    } catch {
      // ignore
    }
  }, [pollMs, pollProgress, requestChunk])

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
    progress,
    scanError,
    startScan,
    cancelScan,
    setScanError,
  }
}
