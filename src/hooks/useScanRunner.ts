'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScanProgress } from '@/types'

interface UseScanRunnerOptions {
  onComplete?: () => void
  onAuthExpired?: () => void
  pollMs?: number
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

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const requestChunk = useCallback(async (body?: { full?: boolean }) => {
    if (chunkInFlight.current) return
    chunkInFlight.current = true
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (data.continued && activeRef.current) {
        // Chain next chunk immediately — don't wait for poll interval
        setTimeout(() => { void requestChunk() }, 300)
      }
    } catch {
      if (activeRef.current) {
        setTimeout(() => { void requestChunk() }, 3000)
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

      if (scanNeedsContinuation(data)) {
        void requestChunk()
      }

      if (data.status === 'complete') {
        activeRef.current = false
        stopPolling()
        setIsScanning(false)
        onComplete?.()
      } else if (data.status === 'cancelled') {
        activeRef.current = false
        stopPolling()
        setIsScanning(false)
      } else if (data.status === 'error' && !data.phase.includes('resume')) {
        activeRef.current = false
        stopPolling()
        if (data.phase === 'Gmail access expired') {
          onAuthExpired?.()
          return
        }
        setScanError(true)
        setIsScanning(false)
      } else if (data.status === 'error') {
        // Resumable error — keep going
        setIsScanning(true)
        void requestChunk()
      }
    } catch {
      // keep polling
    }
  }, [onComplete, onAuthExpired, requestChunk, stopPolling])

  const startScan = useCallback((full = false) => {
    activeRef.current = true
    setIsScanning(true)
    setScanError(false)
    setProgress({ status: 'scanning', phase: 'Connecting to Gmail...', scanned: 0, total: 0 })
    stopPolling()
    void requestChunk({ full })
    pollRef.current = setInterval(() => { void pollProgress() }, pollMs)
  }, [pollMs, pollProgress, requestChunk, stopPolling])

  const cancelScan = useCallback(async () => {
    activeRef.current = false
    await fetch('/api/scan/cancel', { method: 'POST' }).catch(() => {})
  }, [])

  const resumeIfNeeded = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/progress')
      if (!res.ok) return
      const data: ScanProgress = await res.json()
      if (scanNeedsContinuation(data) || data.status === 'error') {
        activeRef.current = true
        setIsScanning(true)
        setProgress(data)
        setScanError(false)
        void requestChunk()
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
    progress,
    scanError,
    startScan,
    cancelScan,
    setScanError,
  }
}
