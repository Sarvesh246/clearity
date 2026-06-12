'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, Circle, XCircle, MinusCircle } from 'lucide-react'
import { formatCount } from '@/lib/utils'
import type { UserSender, ScanProgress } from '@/types'

interface ProgressModalProps {
  isOpen: boolean
  actionType: 'trash' | 'mark_read' | 'archive' | 'unsub_delete' | 'unsub_only'
  senders: UserSender[]
  onComplete: (result: { processed: number; failed: number }) => void
  onClose: () => void
}

const ACTION_LABELS: Record<string, string> = {
  trash: 'Deleting',
  mark_read: 'Marking as read',
  archive: 'Archiving',
  unsub_delete: 'Unsubscribing & deleting',
  unsub_only: 'Unsubscribing',
}

const ACTION_COLORS: Record<string, string> = {
  trash: '#e84141',
  mark_read: '#45aaf2',
  archive: '#ffb142',
  unsub_delete: '#e84141',
  unsub_only: '#a55eea',
}

const UNSUB_METHOD_LABELS: Record<string, string> = {
  post: 'one-click',
  mailto: 'via email',
  url_get: 'via URL',
  none: 'no automatic method',
}

const STALL_MESSAGES = [
  'Working on it...',
  'Still going...',
  'Almost there...',
  'Finishing up...',
]

export default function ProgressModal({
  isOpen,
  actionType,
  senders,
  onComplete,
  onClose,
}: ProgressModalProps) {
  const router = useRouter()
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [view, setView] = useState<'progress' | 'summary' | 'error'>('progress')
  const [result, setResult] = useState<{ processed: number; failed: number; unsubscribed?: number } | null>(null)
  const [stallMsgIndex, setStallMsgIndex] = useState(0)
  const lastProcessedRef = useRef<number>(-1)
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stallCycleRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(Date.now())

  // Escape key dismisses the modal when in progress view
  useEffect(() => {
    if (!isOpen || view !== 'progress') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, view, onClose])

  const accentColor = ACTION_COLORS[actionType]

  function clearStallTimers() {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current)
    if (stallCycleRef.current) clearInterval(stallCycleRef.current)
    stallTimerRef.current = null
    stallCycleRef.current = null
  }

  function resetStallDetection(processed: number) {
    if (processed !== lastProcessedRef.current) {
      lastProcessedRef.current = processed
      clearStallTimers()
      setStallMsgIndex(0)
      stallTimerRef.current = setTimeout(() => {
        stallCycleRef.current = setInterval(() => {
          setStallMsgIndex(i => (i + 1) % STALL_MESSAGES.length)
        }, 3000)
      }, 5000)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      setView('progress')
      setProgress(null)
      setResult(null)
      setStallMsgIndex(0)
      clearStallTimers()
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }
    startedAtRef.current = Date.now()

    async function poll() {
      try {
        const res = await fetch('/api/scan/progress')
        if (!res.ok) return
        const data: ScanProgress = await res.json()
        setProgress(data)
        resetStallDetection(data.processed ?? 0)

        if (data.status === 'complete') {
          if (pollRef.current) clearInterval(pollRef.current)
          clearStallTimers()
          const processed = data.processed ?? 0
          const unsubscribed = data.unsubscribe_statuses
            ? Object.values(data.unsubscribe_statuses).filter(s => s.success).length
            : undefined
          setResult({ processed, failed: 0, unsubscribed })
          setView('summary')
          onComplete({ processed, failed: 0 })
        } else if (data.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current)
          clearStallTimers()
          setView('error')
        }
      } catch {
        // network error — keep polling
      }
    }

    poll()
    pollRef.current = setInterval(poll, 1500)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearStallTimers()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  if (!isOpen) return null

  const processed = progress?.processed ?? 0
  const total = progress?.total ?? 0
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const senderStatuses = progress?.sender_statuses ?? {}
  const unsubStatuses = progress?.unsubscribe_statuses ?? {}
  const isStalled = stallTimerRef.current === null && stallCycleRef.current !== null

  const isUnsubPhase = actionType === 'unsub_delete' && progress?.phase === 'Unsubscribing...'
  const isDeletePhase = actionType === 'unsub_delete' && progress?.phase !== 'Unsubscribing...'

  // ETA calculation for bulk-delete phases
  const etaText = (() => {
    if (!progress || processed <= 100 || total <= 0) return ''
    const elapsed = Date.now() - startedAtRef.current
    const rate = processed / Math.max(elapsed, 1)
    const etaMs = rate > 0 ? (total - processed) / rate : 0
    const etaMins = Math.ceil(etaMs / 60_000)
    return etaMins <= 1 ? ' · <1 min left' : ` · ~${etaMins} min left`
  })()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${ACTION_LABELS[actionType]} progress`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(17, 17, 22, 0.75)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="neu-card"
        style={{ borderRadius: 24, padding: 24, width: '100%', maxWidth: 400 }}
      >
        {view === 'progress' && (
          <>
            {/* Header */}
            <p
              className="text-white font-semibold"
              style={{ fontSize: 17, marginBottom: 20, textAlign: 'center' }}
            >
              {isStalled
                ? STALL_MESSAGES[stallMsgIndex]
                : isUnsubPhase
                  ? 'Unsubscribing...'
                  : isDeletePhase
                    ? 'Deleting emails...'
                    : `${ACTION_LABELS[actionType]} emails...`}
            </p>

            {/* Phase indicator for unsub_delete */}
            {actionType === 'unsub_delete' && (
              <p style={{ fontSize: 12, color: '#8888a0', textAlign: 'center', marginBottom: 16 }}>
                {isUnsubPhase ? 'Phase 1 of 2' : 'Phase 2 of 2'}
              </p>
            )}

            {/* Phase 1: Unsubscribe results */}
            {isUnsubPhase && senders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Unsubscribing:
                </p>
                {senders.map(sender => {
                  const status = senderStatuses[sender.sender_email]
                  const unsubResult = unsubStatuses[sender.sender_email]
                  const methodLabel = unsubResult ? UNSUB_METHOD_LABELS[unsubResult.method] : ''
                  return (
                    <div
                      key={sender.sender_email}
                      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                    >
                      <span style={{ flexShrink: 0, width: 18, display: 'flex', alignItems: 'center' }}>
                        {status === 'done' ? (
                          unsubResult?.success ? (
                            <CheckCircle2 size={16} color="#26de81" strokeWidth={2} />
                          ) : unsubResult?.method === 'none' ? (
                            <MinusCircle size={16} color="#ffb142" strokeWidth={2} />
                          ) : (
                            <XCircle size={16} color="#e84141" strokeWidth={2} />
                          )
                        ) : status === 'in_progress' ? (
                          <Loader2 size={16} color={accentColor} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
                        ) : (
                          <Circle size={16} color="#555566" strokeWidth={1.5} />
                        )}
                      </span>
                      <span style={{ fontSize: 13, color: status === 'done' ? (unsubResult?.success ? '#26de81' : '#8888a0') : status === 'in_progress' ? '#e8e8f0' : '#666678', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sender.sender_name || sender.sender_email}
                      </span>
                      {status === 'done' && (
                        <span style={{ fontSize: 11, color: unsubResult?.success ? '#26de81' : '#666678', flexShrink: 0 }}>
                          {methodLabel}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Phase 2: Delete progress (or standard trash/archive/mark_read) */}
            {!isUnsubPhase && (
              <>
                {/* Progress bar */}
                <div
                  className="neu-inset"
                  style={{ borderRadius: 8, height: 10, marginBottom: 10, overflow: 'hidden' }}
                >
                  <div
                    style={{
                      height: '100%',
                      borderRadius: 8,
                      background: accentColor,
                      width: `${pct}%`,
                      transition: 'width 0.4s ease',
                      boxShadow: `0 0 8px ${accentColor}80`,
                    }}
                  />
                </div>

                {/* Count */}
                <p
                  aria-live="polite"
                  aria-atomic="true"
                  style={{ fontSize: 13, color: '#8888a0', textAlign: 'center', marginBottom: 20 }}
                >
                  {total > 0 ? (
                    <>
                      Processed{' '}
                      <span className="text-white font-medium">{processed.toLocaleString()}</span>
                      {' / '}
                      <span className="text-white font-medium">{total.toLocaleString()}</span>
                      {' '}emails{' '}
                      <span style={{ color: accentColor }}>({pct}%)</span>
                      {etaText}
                    </>
                  ) : (
                    'Collecting message IDs...'
                  )}
                </p>

                {/* Per-sender status */}
                {senders.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Working on:
                    </p>
                    {senders.map(sender => {
                      const status = senderStatuses[sender.sender_email]
                      return (
                        <div
                          key={sender.sender_email}
                          style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                        >
                          <span style={{ flexShrink: 0, width: 18, display: 'flex', alignItems: 'center' }}>
                            {status === 'done' ? (
                              <CheckCircle2 size={16} color="#26de81" strokeWidth={2} />
                            ) : status === 'in_progress' ? (
                              <Loader2 size={16} color={accentColor} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
                            ) : (
                              <Circle size={16} color="#555566" strokeWidth={1.5} />
                            )}
                          </span>
                          <span style={{ fontSize: 13, color: status === 'done' ? '#26de81' : status === 'in_progress' ? '#e8e8f0' : '#666678', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {sender.sender_name || sender.sender_email}
                          </span>
                          <span style={{ fontSize: 12, color: '#666678', flexShrink: 0 }}>
                            {formatCount(sender.email_count)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {view === 'summary' && result && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <CheckCircle2 size={48} color="#26de81" strokeWidth={1.5} />
            <div>
              <p className="text-white font-semibold" style={{ fontSize: 20, marginBottom: 6 }}>Done</p>
              {actionType === 'unsub_delete' ? (
                <p style={{ fontSize: 15, color: '#8888a0', lineHeight: 1.6 }}>
                  Unsubscribed from{' '}
                  <span className="text-white font-semibold">{result.unsubscribed ?? 0}</span> sender{(result.unsubscribed ?? 0) !== 1 ? 's' : ''}
                  <br />
                  and deleted{' '}
                  <span className="text-white font-semibold">{result.processed.toLocaleString()}</span> emails
                  <br />
                  from <span className="text-white font-semibold">{senders.length}</span> sender{senders.length !== 1 ? 's' : ''}
                </p>
              ) : (
                <p style={{ fontSize: 15, color: '#8888a0', lineHeight: 1.6 }}>
                  {ACTION_LABELS[actionType] === 'Deleting' ? 'Deleted' : ACTION_LABELS[actionType] === 'Archiving' ? 'Archived' : 'Marked read'}{' '}
                  <span className="text-white font-semibold">{result.processed.toLocaleString()}</span> emails
                  <br />
                  from <span className="text-white font-semibold">{senders.length}</span> sender{senders.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                onClick={onClose}
                className="neu-button"
                style={{ padding: '10px 20px', fontSize: 14, fontWeight: 500, color: '#e8e8f0' }}
              >
                Clean up more
              </button>
              <button
                onClick={() => router.push('/dashboard')}
                className="neu-button"
                style={{ padding: '10px 20px', fontSize: 14, fontWeight: 500, color: accentColor }}
              >
                Back to inbox
              </button>
            </div>
          </div>
        )}

        {view === 'error' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <p className="text-white font-semibold" style={{ fontSize: 17 }}>Something went wrong</p>
            <p style={{ fontSize: 14, color: '#8888a0' }}>{progress?.phase ?? 'An error occurred.'}</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={onClose}
                className="neu-button"
                style={{ padding: '10px 20px', fontSize: 14, color: '#8888a0' }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setView('progress')
                  setProgress(null)
                }}
                className="neu-button"
                style={{ padding: '10px 20px', fontSize: 14, fontWeight: 500, color: accentColor }}
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
