'use client'

import { useReducer, useMemo, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence } from 'framer-motion'
import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import type { UserSender, FilterValue, Classification } from '@/types'
import FilterTabs from './FilterTabs'
import SenderCard from './SenderCard'
import ActionBar from './ActionBar'
import ProgressModal from './ProgressModal'
import InstallPrompt from './InstallPrompt'

interface SenderListProps {
  senders: UserSender[]
}

interface ActiveAction {
  type: 'trash' | 'mark_read' | 'archive' | 'unsub_delete' | 'unsub_only'
  senders: UserSender[]
}

interface SenderState {
  selectedSenders: Set<string>
  activeFilter: FilterValue
  localSenders: UserSender[]
  activeAction: ActiveAction | null
  hideZeroEmail: boolean
  overrides: Map<string, Classification>
}

type SenderAction =
  | { type: 'TOGGLE_SENDER'; email: string }
  | { type: 'SELECT_ALL_VISIBLE'; visibleEmails: string[] }
  | { type: 'DESELECT_ALL' }
  | { type: 'SET_FILTER'; filter: FilterValue }
  | { type: 'REMOVE_SENDERS'; emails: Set<string> }
  | { type: 'ZERO_UNREAD'; emails: Set<string> }
  | { type: 'ZERO_COUNTS'; emails: Set<string> }
  | { type: 'MARK_UNSUBSCRIBED'; emails: Set<string> }
  | { type: 'MARK_UNSUBSCRIBED_KEEP_COUNTS'; emails: Set<string> }
  | { type: 'SET_ACTIVE_ACTION'; action: ActiveAction | null }
  | { type: 'INIT_SENDERS'; senders: UserSender[] }
  | { type: 'TOGGLE_HIDE_ZERO' }
  | { type: 'SET_OVERRIDE'; email: string; classification: Classification | null }

function senderReducer(state: SenderState, action: SenderAction): SenderState {
  switch (action.type) {
    case 'TOGGLE_SENDER': {
      const next = new Set(state.selectedSenders)
      if (next.has(action.email)) next.delete(action.email)
      else next.add(action.email)
      return { ...state, selectedSenders: next }
    }
    case 'SELECT_ALL_VISIBLE':
      return { ...state, selectedSenders: new Set(action.visibleEmails) }
    case 'DESELECT_ALL':
      return { ...state, selectedSenders: new Set() }
    case 'SET_FILTER':
      return { ...state, activeFilter: action.filter }
    case 'REMOVE_SENDERS':
      return {
        ...state,
        localSenders: state.localSenders.filter(s => !action.emails.has(s.sender_email)),
        selectedSenders: new Set([...state.selectedSenders].filter(e => !action.emails.has(e))),
      }
    case 'ZERO_UNREAD':
      return {
        ...state,
        localSenders: state.localSenders.map(s =>
          action.emails.has(s.sender_email) ? { ...s, unread_count: 0 } : s
        ),
      }
    case 'ZERO_COUNTS':
      return {
        ...state,
        localSenders: state.localSenders.map(s =>
          action.emails.has(s.sender_email) ? { ...s, email_count: 0, unread_count: 0 } : s
        ),
      }
    case 'MARK_UNSUBSCRIBED_KEEP_COUNTS':
      return {
        ...state,
        localSenders: state.localSenders.map(s =>
          action.emails.has(s.sender_email) ? { ...s, is_unsubscribed: true } : s
        ),
      }
    case 'MARK_UNSUBSCRIBED':
      return {
        ...state,
        localSenders: state.localSenders.map(s =>
          action.emails.has(s.sender_email)
            ? { ...s, is_unsubscribed: true, email_count: 0, unread_count: 0 }
            : s
        ),
      }
    case 'SET_ACTIVE_ACTION':
      return { ...state, activeAction: action.action }
    case 'INIT_SENDERS':
      return { ...state, localSenders: action.senders }
    case 'TOGGLE_HIDE_ZERO':
      return { ...state, hideZeroEmail: !state.hideZeroEmail }
    case 'SET_OVERRIDE': {
      const next = new Map(state.overrides)
      if (action.classification === null) next.delete(action.email)
      else next.set(action.email, action.classification)
      return {
        ...state,
        overrides: next,
        localSenders: state.localSenders.map(s =>
          s.sender_email === action.email
            ? { ...s, classification: action.classification ?? s.classification }
            : s
        ),
      }
    }
  }
}

export default function SenderList({ senders }: SenderListProps) {
  const router = useRouter()
  const [state, dispatch] = useReducer(senderReducer, {
    selectedSenders: new Set<string>(),
    activeFilter: 'all',
    localSenders: senders,
    activeAction: null,
    hideZeroEmail: true,
    overrides: new Map(),
  })

  const { selectedSenders, activeFilter, localSenders, activeAction, hideZeroEmail } = state

  // Action POST outcome, fed to the ProgressModal: the response is the
  // authoritative completion/error signal (polling alone can race against
  // stale scan_jobs rows). lastRequestRef lets the error view's Retry re-send.
  const [serverResult, setServerResult] =
    useState<{ processed: number; failed: number; unsubscribed?: number } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const lastRequestRef = useRef<{ url: string; body: object } | null>(null)
  // Remount the modal per action so its internal state starts fresh each time
  const [actionEpoch, setActionEpoch] = useState(0)

  // Sync if parent re-fetches (e.g., navigation)
  useEffect(() => {
    dispatch({ type: 'INIT_SENDERS', senders })
  }, [senders])

  async function postAction(url: string, body: object) {
    lastRequestRef.current = { url, body }
    setServerResult(null)
    setActionError(null)
    setActionEpoch(e => e + 1)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({} as Record<string, unknown>))
      if (res.status === 401) {
        router.push('/?message=gmail_auth_expired')
        return
      }
      if (!res.ok) {
        setActionError(
          (typeof data.message === 'string' && data.message) ||
          (typeof data.error === 'string' && data.error) ||
          'Something went wrong — please try again.'
        )
        return
      }
      setServerResult({
        processed: typeof data.processed === 'number' ? data.processed : 0,
        failed: typeof data.failed === 'number' ? data.failed : 0,
        unsubscribed: typeof data.unsubscribed === 'number' ? data.unsubscribed : undefined,
      })
    } catch {
      // Network drop — the action may still be running server-side; the
      // modal's polling (or its watchdog) takes over from here.
    }
  }

  function retryLastAction() {
    const last = lastRequestRef.current
    if (last) void postAction(last.url, last.body)
  }

  // "Cleaned" = already unsubscribed OR emptied. Hidden by default so the junk
  // and other category tabs only surface senders still worth acting on; the
  // "Show cleaned" toggle brings them back.
  const isCleaned = (s: UserSender) => s.is_unsubscribed || s.email_count === 0

  const actionableSenders = useMemo(
    () => (hideZeroEmail ? localSenders.filter(s => !isCleaned(s)) : localSenders),
    [localSenders, hideZeroEmail]
  )

  const visibleSenders = useMemo(() => {
    return activeFilter === 'all'
      ? actionableSenders
      : actionableSenders.filter(s => s.classification === activeFilter)
  }, [actionableSenders, activeFilter])

  const visibleEmails = useMemo(
    () => visibleSenders.map(s => s.sender_email),
    [visibleSenders]
  )

  const allVisibleSelected =
    visibleSenders.length > 0 && visibleSenders.every(s => selectedSenders.has(s.sender_email))

  const selectedCount = selectedSenders.size

  const selectedTotalEmails = useMemo(() => {
    return localSenders
      .filter(s => selectedSenders.has(s.sender_email))
      .reduce((sum, s) => sum + s.email_count, 0)
  }, [localSenders, selectedSenders])

  const hasUnsubscribable = useMemo(() => {
    return localSenders
      .filter(s => selectedSenders.has(s.sender_email))
      .some(s => s.has_unsubscribe_header)
  }, [localSenders, selectedSenders])

  const unsubscribableCount = useMemo(() => {
    return localSenders
      .filter(s => selectedSenders.has(s.sender_email) && s.has_unsubscribe_header)
      .length
  }, [localSenders, selectedSenders])

  // Tab counts track the same cleaned filter as the list so the number on each
  // tab matches the rows shown under it.
  const counts = useMemo(() => ({
    all: actionableSenders.length,
    junk: actionableSenders.filter(s => s.classification === 'junk').length,
    unsure: actionableSenders.filter(s => s.classification === 'unsure').length,
    safe: actionableSenders.filter(s => s.classification === 'safe').length,
  }), [actionableSenders])

  function handleAction(actionType: 'trash' | 'mark_read' | 'archive') {
    const selected = localSenders.filter(s => selectedSenders.has(s.sender_email))
    if (selected.length === 0) return

    dispatch({ type: 'SET_ACTIVE_ACTION', action: { type: actionType, senders: selected } })
    void postAction('/api/actions', {
      action: actionType,
      senderEmails: selected.map(s => s.sender_email),
    })
  }

  function handleUnsubscribeAndDelete() {
    const selected = localSenders.filter(s => selectedSenders.has(s.sender_email))
    if (selected.length === 0) return

    dispatch({ type: 'SET_ACTIVE_ACTION', action: { type: 'unsub_delete', senders: selected } })
    void postAction('/api/unsubscribe', {
      senderEmails: selected.map(s => s.sender_email),
    })
  }

  function handleUnsubscribeOnly() {
    const eligible = localSenders.filter(s =>
      selectedSenders.has(s.sender_email) && s.has_unsubscribe_header
    )
    if (!eligible.length) return

    dispatch({ type: 'SET_ACTIVE_ACTION', action: { type: 'unsub_only', senders: eligible } })
    void postAction('/api/unsubscribe', {
      senderEmails: eligible.map(s => s.sender_email),
      deleteAfter: false,
    })
  }

  async function handleOverride(email: string, classification: Classification | null) {
    dispatch({ type: 'SET_OVERRIDE', email, classification })
    await fetch('/api/overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderEmail: email, override: classification }),
    }).catch(() => {})
  }

  function handleActionComplete() {
    if (!activeAction) return
    const emails = new Set(activeAction.senders.map(s => s.sender_email))

    if (activeAction.type === 'trash') {
      dispatch({ type: 'REMOVE_SENDERS', emails })
    } else if (activeAction.type === 'mark_read') {
      dispatch({ type: 'ZERO_UNREAD', emails })
    } else if (activeAction.type === 'unsub_delete') {
      const unsubscribedEmails = new Set(
        activeAction.senders.filter(s => s.has_unsubscribe_header).map(s => s.sender_email)
      )
      dispatch({ type: 'MARK_UNSUBSCRIBED', emails: unsubscribedEmails })
      // Emails were deleted for every selected sender — zero their counts too
      const nonUnsubEmails = new Set(
        activeAction.senders.filter(s => !s.has_unsubscribe_header).map(s => s.sender_email)
      )
      if (nonUnsubEmails.size > 0) dispatch({ type: 'ZERO_COUNTS', emails: nonUnsubEmails })
    } else if (activeAction.type === 'unsub_only') {
      // Only mark as unsubscribed — no emails were deleted, keep counts
      dispatch({ type: 'MARK_UNSUBSCRIBED_KEEP_COUNTS', emails })
    }

    // Keep activeAction set: the modal stays open showing the summary screen.
    // onClose (Clean up more / Escape) clears it.
    dispatch({ type: 'DESELECT_ALL' })
  }

  function handleModalClose() {
    setServerResult(null)
    setActionError(null)
    dispatch({ type: 'SET_ACTIVE_ACTION', action: null })
  }

  // Empty: no senders at all
  if (localSenders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-6 px-6" style={{ paddingTop: 80 }}>
        <div
          className="neu-inset flex items-center justify-center"
          style={{ width: 64, height: 64, borderRadius: 20 }}
        >
          <ScanLine size={28} color="#a55eea" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col gap-2 text-center">
          <h3 className="font-semibold text-white" style={{ fontSize: 17 }}>No senders yet</h3>
          <p style={{ fontSize: 14, color: '#8888a0', lineHeight: 1.5 }}>
            Scan your inbox to discover and classify your senders.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="neu-button flex items-center gap-2 px-6 py-3 text-white font-medium"
          style={{ fontSize: 14 }}
        >
          <ScanLine size={16} strokeWidth={1.75} />
          Scan My Inbox
        </Link>
      </div>
    )
  }

  // Empty: all cleaned
  const allCleaned = localSenders.every(s => s.is_unsubscribed)
  if (allCleaned) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-6" style={{ paddingTop: 80 }}>
        <span style={{ fontSize: 56 }}>🎉</span>
        <div className="flex flex-col gap-2 text-center">
          <h3 className="font-semibold text-white" style={{ fontSize: 17 }}>Inbox looking clean</h3>
          <p style={{ fontSize: 14, color: '#8888a0' }}>You&apos;ve unsubscribed from all senders.</p>
        </div>
      </div>
    )
  }

  // Select All label
  let selectAllLabel: string
  if (allVisibleSelected) {
    selectAllLabel = 'Deselect All'
  } else if (selectedCount > 0) {
    selectAllLabel = `${selectedCount} of ${localSenders.length} selected`
  } else {
    selectAllLabel = 'Select All'
  }

  function handleSelectAll() {
    if (allVisibleSelected) {
      dispatch({ type: 'DESELECT_ALL' })
    } else {
      dispatch({ type: 'SELECT_ALL_VISIBLE', visibleEmails })
    }
  }

  return (
    <div className="flex flex-col flex-1" style={{ minHeight: 0 }}>
      {/* Filter tabs */}
      <div style={{ paddingTop: 12, paddingBottom: 12 }}>
        <FilterTabs
          activeFilter={activeFilter}
          counts={counts}
          onFilterChange={filter => dispatch({ type: 'SET_FILTER', filter })}
        />
      </div>

      {/* Select All row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid #2c2c35',
        }}
      >
        <button
          onClick={handleSelectAll}
          className="neu-button"
          style={{
            padding: '6px 12px',
            fontSize: 13,
            fontWeight: 500,
            color: allVisibleSelected ? '#a55eea' : '#e8e8f0',
          }}
        >
          {allVisibleSelected ? 'Deselect All' : 'Select All'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#8888a0' }}>
            {selectedCount > 0 && selectedCount < localSenders.length
              ? selectAllLabel
              : `${visibleSenders.length.toLocaleString()} senders`}
          </span>
          <button
            onClick={() => dispatch({ type: 'TOGGLE_HIDE_ZERO' })}
            className="neu-button"
            style={{ padding: '4px 10px', fontSize: 12, color: '#8888a0' }}
            aria-pressed={hideZeroEmail}
          >
            {hideZeroEmail ? 'Show cleaned' : 'Hide cleaned'}
          </button>
        </div>
      </div>

      {/* Sender list */}
      <div
        className="overflow-y-auto flex-1"
        style={{ paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}
      >
        {visibleSenders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6" style={{ paddingTop: 60 }}>
            <span style={{ fontSize: 36 }}>🔍</span>
            <p style={{ fontSize: 14, color: '#8888a0', textAlign: 'center' }}>
              No {activeFilter} senders found
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-3">
            {visibleSenders.map(sender => (
              <SenderCard
                key={sender.id}
                sender={sender}
                isSelected={selectedSenders.has(sender.sender_email)}
                onToggle={email => dispatch({ type: 'TOGGLE_SENDER', email })}
                onOverride={handleOverride}
                overriddenAs={state.overrides.get(sender.sender_email) ?? null}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <AnimatePresence>
        {selectedCount > 0 && (
          <ActionBar
            key="action-bar"
            selectedCount={selectedCount}
            totalEmailCount={selectedTotalEmails}
            hasUnsubscribable={hasUnsubscribable}
            unsubscribableCount={unsubscribableCount}
            onDeleteAll={() => handleAction('trash')}
            onMarkRead={() => handleAction('mark_read')}
            onArchive={() => handleAction('archive')}
            onUnsubscribeAndDelete={handleUnsubscribeAndDelete}
            onUnsubscribeOnly={handleUnsubscribeOnly}
          />
        )}
      </AnimatePresence>

      {/* Progress modal */}
      <ProgressModal
        key={actionEpoch}
        isOpen={activeAction !== null}
        actionType={activeAction?.type ?? 'trash'}
        senders={activeAction?.senders ?? []}
        onComplete={handleActionComplete}
        onClose={handleModalClose}
        serverResult={serverResult}
        serverError={actionError}
        onRetry={retryLastAction}
      />

      <InstallPrompt />
    </div>
  )
}
