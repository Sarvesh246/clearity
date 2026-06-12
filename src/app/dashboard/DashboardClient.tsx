'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, ScanLine, LogOut, AlertCircle } from 'lucide-react'
import { signOut } from '@/app/actions/auth'
import { useScanRunner } from '@/hooks/useScanRunner'

interface Props {
  email: string
}

export default function DashboardClient({ email }: Props) {
  const router = useRouter()
  const [dots, setDots] = useState('.')
  const {
    isScanning,
    progress,
    scanError,
    startScan,
    setScanError,
  } = useScanRunner({
    onComplete: () => router.push('/dashboard/senders'),
    onAuthExpired: () => router.push('/?message=gmail_auth_expired'),
  })

  useEffect(() => {
    if (!isScanning) return
    const id = setInterval(() => {
      setDots(d => d.length >= 3 ? '.' : d + '.')
    }, 500)
    return () => clearInterval(id)
  }, [isScanning])

  function handleStartScan(resume = false) {
    setScanError(false)
    startScan(resume ? { resume: true } : { full: true })
  }

  const isListing = isScanning && progress.list_complete === false
  const displayScanned = Math.max(progress.cursor ?? 0, progress.scanned ?? 0)
  const pct = isListing
    ? 0
    : progress.total > 0
      ? Math.min(99, Math.round((displayScanned / progress.total) * 100))
      : 0

  return (
    <div className="w-full max-w-sm flex flex-col gap-6">
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

      <div className="neu-card flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-white" style={{ letterSpacing: '-0.02em' }}>
            Inbox Scanner
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: '#8888a0' }}>
            Scan your Gmail inbox to classify senders and find emails to clean up.
            Large inboxes scan in the background — keep this tab open until complete.
          </p>
        </div>

        {!isScanning && !scanError && (
          <button
            onClick={() => handleStartScan()}
            className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-medium text-base"
          >
            <ScanLine size={18} strokeWidth={1.75} />
            Scan My Inbox
          </button>
        )}

        {isScanning && (
          <div className="flex flex-col gap-3">
            <div
              className="neu-inset w-full overflow-hidden"
              style={{ height: 8, borderRadius: 99 }}
            >
              {isListing ? (
                <div
                  className="h-full w-1/3"
                  style={{
                    background: '#45aaf2',
                    borderRadius: 99,
                    animation: 'scan-indeterminate 1.5s ease-in-out infinite',
                  }}
                />
              ) : (
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
              )}
            </div>

            <p className="text-sm font-medium" style={{ color: '#8888a0' }}>
              {progress.phase}{dots}
            </p>

            {progress.total > 0 && (
              <p className="text-xs" style={{ color: '#555568' }}>
                {isListing
                  ? `${progress.total.toLocaleString()} emails found so far`
                  : `${pct}% — ${displayScanned.toLocaleString()} / ${progress.total.toLocaleString()} emails`}
              </p>
            )}
          </div>
        )}

        {scanError && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2" style={{ color: '#e84141' }}>
              <AlertCircle size={16} strokeWidth={1.75} />
              <span className="text-sm font-medium">Scan failed. Tap retry to continue where it left off.</span>
            </div>
            <button
              onClick={() => handleStartScan(true)}
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-medium text-base"
            >
              <ScanLine size={18} strokeWidth={1.75} />
              Retry Scan
            </button>
          </div>
        )}
      </div>

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
