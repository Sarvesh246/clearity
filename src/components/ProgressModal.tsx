'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** Authoritative result from the action POST — finalizes even if polling lags. */
  serverResult?: { processed: number; failed: number; unsubscribed?: number } | null
  /** Error from the action POST (e.g. 409 scan running) — shows the error view. */
  serverError?: string | null
  /** Re-issues the failed action POST from the error view. */
  onRetry?: () => void
}

/** If the job row never shows our action running within this window, the POST
 * likely never reached the server — surface an error instead of spinning. */
const START_WATCHDOG_MS = 20_000

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

const COMPACT_LIST_THRESHOLD = 6
const MAX_ACTIVE_SENDERS = 3

function countSendersByStatus(
  senders: UserSender[],
  statuses: Record<string, 'queued' | 'in_progress' | 'done'>
) {
  let done = 0
  let inProgress = 0
  for (const s of senders) {
    const status = statuses[s.sender_email]
    if (status === 'done') done++
    else if (status === 'in_progress') inProgress++
  }
  return { done, inProgress, total: senders.length }
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      className="neu-inset"
      style={{ borderRadius: 8, height: 10, overflow: 'hidden' }}
    >
      <div
        style={{
          height: '100%',
          borderRadius: 8,
          background: color,
          width: `${pct}%`,
          transition: 'width 0.4s ease',
          boxShadow: `0 0 8px ${color}80`,
        }}
      />
    </div>
  )
}

function SenderRow({
  sender,
  status,
  accentColor,
  trailing,
  nameColor,
}: {
  sender: UserSender
  status: 'queued' | 'in_progress' | 'done'
  accentColor: string
  trailing?: ReactNode
  nameColor?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ flexShrink: 0, width: 18, display: 'flex', alignItems: 'center' }}>
        {status === 'done' ? (
          <CheckCircle2 size={16} color="#26de81" strokeWidth={2} />
        ) : status === 'in_progress' ? (
          <Loader2
            size={16}
            color={accentColor}
            strokeWidth={2}
            style={{ animation: 'spin 1s linear infinite' }}
          />
        ) : (
          <Circle size={16} color="#555566" strokeWidth={1.5} />
        )}
      </span>
      <span
        style={{
          fontSize: 13,
          color: nameColor ?? (status === 'done' ? '#26de81' : status === 'in_progress' ? '#e8e8f0' : '#666678'),
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {sender.sender_name || sender.sender_email}
      </span>
      {trailing}
    </div>
  )
}

export default function ProgressModal({
  isOpen,
  actionType,
  senders,
  onComplete,
  onClose,
  serverResult = null,
  serverError = null,
  onRetry,
}: ProgressModalProps) {
  const router = useRouter()
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [view, setView] = useState<'progress' | 'summary' | 'error'>('progress')
  const [result, setResult] = useState<{ processed: number; failed: number; unsubscribed?: number } | null>(null)
  const [stallMsgIndex, setStallMsgIndex] = useState(0)
  const [isStalled, setIsStalled] = useState(false)
  const [etaText, setEtaText] = useState('')
  const [watchdogTripped, setWatchdogTripped] = useState(false)
  // Bumped on Retry so the polling effect tears down and starts fresh.
  const [pollEpoch, setPollEpoch] = useState(0)
  const lastProcessedRef = useRef<number>(-1)
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stallCycleRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  // The scan_jobs row is shared with scans and previous actions, so the first
  // polls can return a stale 'complete'/'error' row from an earlier run. Only
  // honor those statuses after this action has been observed running.
  const sawRunningRef = useRef(false)
  const finalizedRef = useRef(false)

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
      setIsStalled(false)
      setStallMsgIndex(0)
      stallTimerRef.current = setTimeout(() => {
        setIsStalled(true)
        stallCycleRef.current = setInterval(() => {
          setStallMsgIndex(i => (i + 1) % STALL_MESSAGES.length)
        }, 3000)
      }, 5000)
    }
  }

  // Note: the parent remounts this component per action (key prop), so there is
  // no state to reset on close — only timers need cleanup.
  useEffect(() => {
    if (!isOpen) {
      clearStallTimers()
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }
    startedAtRef.current = Date.now()
    sawRunningRef.current = false
    finalizedRef.current = false

    function finalize(processed: number, unsubscribed?: number) {
      if (finalizedRef.current) return
      finalizedRef.current = true
      if (pollRef.current) clearInterval(pollRef.current)
      clearStallTimers()
      setResult({ processed, failed: 0, unsubscribed })
      setView('summary')
      onComplete({ processed, failed: 0 })
    }

    async function poll() {
      try {
        const res = await fetch('/api/scan/progress', { cache: 'no-store' })
        if (!res.ok) return
        const data: ScanProgress = await res.json()

        // The row currently belongs to a scan, not a bulk action — ignore it.
        if (!data.action_type) return

        setProgress(data)
        resetStallDetection(data.processed ?? 0)

        // ETA for bulk-delete phases (computed here — render must stay pure)
        const processedNow = data.processed ?? 0
        const totalNow = data.total ?? 0
        if (processedNow > 100 && totalNow > 0) {
          const elapsed = Date.now() - startedAtRef.current
          const rate = processedNow / Math.max(elapsed, 1)
          const etaMs = rate > 0 ? (totalNow - processedNow) / rate : 0
          const etaMins = Math.ceil(etaMs / 60_000)
          setEtaText(etaMins <= 1 ? ' · <1 min left' : ` · ~${etaMins} min left`)
        } else {
          setEtaText('')
        }

        if (data.status === 'scanning') {
          sawRunningRef.current = true
          return
        }

        // Stale terminal rows from a previous run must not finalize this one.
        if (!sawRunningRef.current) return

        if (data.status === 'complete') {
          const unsubscribed = data.unsubscribe_statuses
            ? Object.values(data.unsubscribe_statuses).filter(s => s.success).length
            : undefined
          finalize(data.processed ?? 0, unsubscribed)
        } else if (data.status === 'error') {
          if (finalizedRef.current) return
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

    const watchdog = setTimeout(() => {
      if (!sawRunningRef.current && !finalizedRef.current) setWatchdogTripped(true)
    }, START_WATCHDOG_MS)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearTimeout(watchdog)
      clearStallTimers()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pollEpoch])

  // Authoritative completion from the action POST itself — covers actions that
  // finish between polls and the very-fast path where polling never observes
  // the 'scanning' state.
  useEffect(() => {
    if (!isOpen || !serverResult) return
    // Deferred so the effect doesn't set state synchronously
    const timer = setTimeout(() => {
      if (finalizedRef.current) return
      finalizedRef.current = true
      if (pollRef.current) clearInterval(pollRef.current)
      clearStallTimers()
      setResult(serverResult)
      setView('summary')
      onComplete({ processed: serverResult.processed, failed: serverResult.failed })
    }, 0)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, serverResult])

  if (!isOpen) return null

  const showError =
    view === 'error' || (view === 'progress' && (!!serverError || watchdogTripped))
  const showProgress = view === 'progress' && !showError
  const errorMessage =
    serverError ??
    (view === 'error'
      ? progress?.phase ?? 'An error occurred.'
      : "Couldn't start — check your connection and try again.")

  const processed = progress?.processed ?? 0
  const total = progress?.total ?? 0
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const senderStatuses = progress?.sender_statuses ?? {}
  const unsubStatuses = progress?.unsubscribe_statuses ?? {}

  const isUnsubPhase =
    (actionType === 'unsub_delete' || actionType === 'unsub_only') &&
    progress?.phase === 'Unsubscribing...'
  const isDeletePhase = actionType === 'unsub_delete' && !isUnsubPhase

  const senderProgress = countSendersByStatus(senders, senderStatuses)
  const senderPct = senderProgress.total > 0
    ? Math.round((senderProgress.done / senderProgress.total) * 100)
    : 0

  const activeSenders = senders.filter(
    s => senderStatuses[s.sender_email] === 'in_progress'
  )
  const hiddenActiveCount = Math.max(0, activeSenders.length - MAX_ACTIVE_SENDERS)
  const visibleActiveSenders = activeSenders.slice(0, MAX_ACTIVE_SENDERS)

  const useCompactList = senders.length <= COMPACT_LIST_THRESHOLD

  const unsubSuccessCount = Object.values(unsubStatuses).filter(s => s.success).length

  const phaseHint = progress?.phase &&
    progress.phase !== 'Unsubscribing...' &&
    progress.phase !== 'Deleting emails...' &&
    progress.phase !== 'Processing emails...' &&
    progress.phase !== 'Done'
      ? progress.phase
      : null

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
        style={{
          borderRadius: 24,
          padding: 24,
          width: '100%',
          maxWidth: 400,
          maxHeight: 'min(90vh, 560px)',
          overflowY: 'auto',
        }}
      >
        {showProgress && (
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

            {senders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {isUnsubPhase ? 'Senders' : 'Senders processed'}
                </p>
                <ProgressBar pct={senderPct} color={isUnsubPhase ? '#a55eea' : accentColor} />
                <p style={{ fontSize: 13, color: '#8888a0', textAlign: 'center' }}>
                  <span className="text-white font-medium">{senderProgress.done.toLocaleString()}</span>
                  {' / '}
                  <span className="text-white font-medium">{senderProgress.total.toLocaleString()}</span>
                  {' '}senders{' '}
                  <span style={{ color: isUnsubPhase ? '#a55eea' : accentColor }}>({senderPct}%)</span>
                  {isUnsubPhase && unsubSuccessCount > 0 && (
                    <span style={{ color: '#26de81' }}> · {unsubSuccessCount} unsubscribed</span>
                  )}
                </p>
              </div>
            )}

            {!isUnsubPhase && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Emails
                </p>
                <ProgressBar pct={total > 0 ? pct : 0} color={accentColor} />
                <p
                  aria-live="polite"
                  aria-atomic="true"
                  style={{ fontSize: 13, color: '#8888a0', textAlign: 'center' }}
                >
                  {total > 0 ? (
                    <>
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
              </div>
            )}

            {phaseHint && (
              <p
                style={{
                  fontSize: 12,
                  color: '#666678',
                  textAlign: 'center',
                  marginBottom: 16,
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={phaseHint}
              >
                {phaseHint}
              </p>
            )}

            {useCompactList ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  maxHeight: 220,
                  overflowY: 'auto',
                  paddingRight: 4,
                }}
              >
                <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {isUnsubPhase ? 'Unsubscribing' : 'Progress'}
                </p>
                {senders.map(sender => {
                  const status = senderStatuses[sender.sender_email] ?? 'queued'
                  const unsubResult = unsubStatuses[sender.sender_email]
                  const methodLabel = unsubResult ? UNSUB_METHOD_LABELS[unsubResult.method] : ''

                  if (isUnsubPhase && status === 'done') {
                    return (
                      <div key={sender.sender_email} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <span style={{ flexShrink: 0, width: 18, display: 'flex', alignItems: 'center' }}>
                          {unsubResult?.success ? (
                            <CheckCircle2 size={16} color="#26de81" strokeWidth={2} />
                          ) : unsubResult?.method === 'none' ? (
                            <MinusCircle size={16} color="#ffb142" strokeWidth={2} />
                          ) : (
                            <XCircle size={16} color="#e84141" strokeWidth={2} />
                          )}
                        </span>
                        <span style={{ fontSize: 13, color: unsubResult?.success ? '#26de81' : '#8888a0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sender.sender_name || sender.sender_email}
                        </span>
                        {methodLabel && (
                          <span style={{ fontSize: 11, color: '#666678', flexShrink: 0 }}>{methodLabel}</span>
                        )}
                      </div>
                    )
                  }

                  return (
                    <SenderRow
                      key={sender.sender_email}
                      sender={sender}
                      status={status}
                      accentColor={accentColor}
                      trailing={
                        !isUnsubPhase ? (
                          <span style={{ fontSize: 12, color: '#666678', flexShrink: 0 }}>
                            {formatCount(sender.email_count)}
                          </span>
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 12, color: '#8888a0', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {activeSenders.length > 0 ? 'Working on now' : senderProgress.done < senderProgress.total ? 'Up next' : 'Finishing up'}
                </p>
                {visibleActiveSenders.length > 0 ? (
                  <>
                    {visibleActiveSenders.map(sender => (
                      <SenderRow
                        key={sender.sender_email}
                        sender={sender}
                        status="in_progress"
                        accentColor={accentColor}
                        trailing={
                          <span style={{ fontSize: 12, color: '#666678', flexShrink: 0 }}>
                            {isUnsubPhase
                              ? (unsubStatuses[sender.sender_email] ? UNSUB_METHOD_LABELS[unsubStatuses[sender.sender_email].method] : '')
                              : formatCount(sender.email_count)}
                          </span>
                        }
                      />
                    ))}
                    {hiddenActiveCount > 0 && (
                      <p style={{ fontSize: 12, color: '#666678', paddingLeft: 28 }}>
                        +{hiddenActiveCount} more in parallel
                      </p>
                    )}
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: '#666678', paddingLeft: 2 }}>
                    {senderProgress.done >= senderProgress.total
                      ? 'Wrapping up...'
                      : total === 0 && !isUnsubPhase
                        ? 'Fetching email list from Gmail...'
                        : `${(senderProgress.total - senderProgress.done).toLocaleString()} senders remaining`}
                  </p>
                )}
              </div>
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

        {showError && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <p className="text-white font-semibold" style={{ fontSize: 17 }}>Something went wrong</p>
            <p style={{ fontSize: 14, color: '#8888a0' }}>{errorMessage}</p>
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
                  setWatchdogTripped(false)
                  setPollEpoch(e => e + 1)
                  onRetry?.()
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
