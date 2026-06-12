'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, ScanLine, LogOut, AlertCircle } from 'lucide-react'
import { signOut } from '@/app/actions/auth'
import type { ScanProgress } from '@/types'

interface Props {
  email: string
}

export default function DashboardClient({ email }: Props) {
  const router = useRouter()
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'error'>('idle')
  const [progress, setProgress] = useState<ScanProgress>({ status: 'idle', phase: '', scanned: 0, total: 0 })
  const [dots, setDots] = useState('.')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Animated dots during scan
  useEffect(() => {
    if (scanState !== 'scanning') return
    const id = setInterval(() => {
      setDots(d => d.length >= 3 ? '.' : d + '.')
    }, 500)
    return () => clearInterval(id)
  }, [scanState])

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    return () => stopPolling()
  }, [])

  async function startScan() {
    setScanState('scanning')
    setProgress({ status: 'scanning', phase: 'Connecting to Gmail...', scanned: 0, total: 0 })

    // Fire scan request — don't await, polling drives the UI
    fetch('/api/scan', { method: 'POST' }).catch(() => {
      // Error is surfaced via the progress polling below
    })

    // Poll progress every 2 seconds
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/scan/progress')
        if (!res.ok) return
        const data: ScanProgress = await res.json()
        setProgress(data)

        if (data.status === 'complete') {
          stopPolling()
          router.push('/dashboard/senders')
        } else if (data.status === 'error') {
          stopPolling()
          setScanState('error')
        }
      } catch {
        // Network error — keep polling
      }
    }, 2000)
  }

  const pct = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0

  return (
    <div className="w-full max-w-sm flex flex-col gap-6">
      {/* Header card */}
      <div className="neu-card flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div
            className="neu-inset flex items-center justify-center flex-shrink-0"
            style={{ width: 40, height: 40, borderRadius: 12 }}
          >
            <Mail size={18} color="#a55eea" strokeWidth={1.75} />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium" style={{ color: '#8888a0' }}>Signed in as</span>
            <span className="text-sm font-semibold text-white truncate">{email}</span>
          </div>
        </div>
      </div>

      {/* Scan card */}
      <div className="neu-card flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-white" style={{ letterSpacing: '-0.02em' }}>
            Inbox Scanner
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: '#8888a0' }}>
            Scan your Gmail inbox to classify senders and find emails to clean up.
          </p>
        </div>

        {scanState === 'idle' && (
          <button
            onClick={startScan}
            className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-medium text-base"
          >
            <ScanLine size={18} strokeWidth={1.75} />
            Scan My Inbox
          </button>
        )}

        {scanState === 'scanning' && (
          <div className="flex flex-col gap-3">
            {/* Progress bar */}
            <div
              className="neu-inset w-full overflow-hidden"
              style={{ height: 8, borderRadius: 99 }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: '#45aaf2',
                  borderRadius: 99,
                  transition: 'width 0.4s ease',
                  minWidth: pct > 0 ? 8 : 0,
                }}
              />
            </div>

            {/* Phase text */}
            <p className="text-sm font-medium" style={{ color: '#8888a0' }}>
              {progress.phase}{dots}
            </p>

            {progress.total > 0 && (
              <p className="text-xs" style={{ color: '#555568' }}>
                {pct}% — {progress.scanned.toLocaleString()} / {progress.total.toLocaleString()} emails
              </p>
            )}
          </div>
        )}

        {scanState === 'error' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2" style={{ color: '#e84141' }}>
              <AlertCircle size={16} strokeWidth={1.75} />
              <span className="text-sm font-medium">Scan failed. Please try again.</span>
            </div>
            <button
              onClick={startScan}
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-medium text-base"
            >
              <ScanLine size={18} strokeWidth={1.75} />
              Retry Scan
            </button>
          </div>
        )}
      </div>

      {/* Sign out */}
      <form action={signOut}>
        <button
          type="submit"
          className="neu-button w-full flex items-center justify-center gap-2 px-6 py-3 font-medium text-sm"
          style={{ color: '#8888a0' }}
        >
          <LogOut size={16} strokeWidth={1.75} />
          Sign out
        </button>
      </form>
    </div>
  )
}
