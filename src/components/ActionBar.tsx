'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Trash2, Mail, Archive, BellOff, X } from 'lucide-react'
import { formatCount } from '@/lib/utils'

interface ActionBarProps {
  selectedCount: number
  totalEmailCount: number
  hasUnsubscribable: boolean
  unsubscribableCount: number
  onDeleteAll: () => void
  onMarkRead: () => void
  onArchive: () => void
  onUnsubscribeAndDelete: () => void
  onUnsubscribeOnly?: () => void
}

interface ActionButton {
  id: string
  label: string
  icon: React.ReactNode
  accentColor: string
  onClick: () => void
  show: boolean
}

const COUNTDOWN_SECONDS = 5

export default function ActionBar({
  selectedCount,
  totalEmailCount,
  hasUnsubscribable,
  unsubscribableCount,
  onDeleteAll,
  onMarkRead,
  onArchive,
  onUnsubscribeAndDelete,
  onUnsubscribeOnly,
}: ActionBarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<{ active: boolean; secondsLeft: number } | null>(null)
  const [showOverflow, setShowOverflow] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Close overflow when clicking outside
  useEffect(() => {
    if (!showOverflow) return
    function close(e: MouseEvent) {
      if (!(e.target as Element).closest('[data-overflow-menu]')) setShowOverflow(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showOverflow])

  // Start countdown when activated
  useEffect(() => {
    if (!countdown?.active) return

    if (countdown.secondsLeft <= 0) {
      // Fire the action
      setCountdown(null)
      if (intervalRef.current) clearInterval(intervalRef.current)
      onDeleteAll()
      return
    }

    intervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (!prev) return null
        const next = prev.secondsLeft - 1
        if (next <= 0) {
          if (intervalRef.current) clearInterval(intervalRef.current)
          return { active: false, secondsLeft: 0 }
        }
        return { ...prev, secondsLeft: next }
      })
    }, 1000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown?.active])

  // Watch for secondsLeft hitting 0 after the interval ticks
  useEffect(() => {
    if (countdown && !countdown.active && countdown.secondsLeft === 0) {
      setCountdown(null)
      onDeleteAll()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown])

  function startCountdown() {
    setCountdown({ active: true, secondsLeft: COUNTDOWN_SECONDS })
  }

  function cancelCountdown() {
    if (intervalRef.current) clearInterval(intervalRef.current)
    setCountdown(null)
  }

  const buttons: ActionButton[] = [
    {
      id: 'delete',
      label: 'Delete All',
      icon: <Trash2 size={16} strokeWidth={1.75} />,
      accentColor: '#e84141',
      onClick: startCountdown,
      show: true,
    },
    {
      id: 'read',
      label: 'Mark Read',
      icon: <Mail size={16} strokeWidth={1.75} />,
      accentColor: '#45aaf2',
      onClick: onMarkRead,
      show: true,
    },
    {
      id: 'archive',
      label: 'Archive',
      icon: <Archive size={16} strokeWidth={1.75} />,
      accentColor: '#ffb142',
      onClick: onArchive,
      show: true,
    },
    {
      id: 'unsub',
      label: 'Unsub + Delete',
      icon: <BellOff size={16} strokeWidth={1.75} />,
      accentColor: '#e84141',
      onClick: onUnsubscribeAndDelete,
      show: hasUnsubscribable,
    },
  ]

  const barWidthPct = countdown
    ? (countdown.secondsLeft / COUNTDOWN_SECONDS) * 100
    : 100

  return (
    <motion.div
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 36 }}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        padding: '12px 16px',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        maxWidth: 672,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
    >
      <div
        className="neu-card"
        style={{ borderRadius: 20, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {/* Summary */}
        <p style={{ fontSize: 13, color: '#8888a0', fontWeight: 500, textAlign: 'center' }}>
          <span className="text-white font-semibold">{selectedCount}</span> senders ·{' '}
          <span className="text-white font-semibold">{formatCount(totalEmailCount)}</span> emails
        </p>

        {countdown ? (
          /* Countdown mode */
          <>
            <p style={{ fontSize: 13, color: '#e8e8f0', textAlign: 'center' }}>
              Deleting{' '}
              <span style={{ color: '#e84141', fontWeight: 600 }}>{formatCount(totalEmailCount)}</span>
              {' '}emails from{' '}
              <span style={{ color: '#e84141', fontWeight: 600 }}>{selectedCount}</span>
              {' '}sender{selectedCount !== 1 ? 's' : ''}
            </p>

            {/* Draining bar */}
            <div
              className="neu-inset"
              style={{ borderRadius: 8, height: 8, overflow: 'hidden' }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: 8,
                  background: '#e84141',
                  width: `${barWidthPct}%`,
                  transition: 'width 1s linear',
                  boxShadow: '0 0 8px #e8414180',
                }}
              />
            </div>

            <button
              onClick={cancelCountdown}
              className="neu-button"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                color: '#8888a0',
                alignSelf: 'center',
              }}
            >
              <X size={14} strokeWidth={2} />
              Cancel
            </button>
          </>
        ) : (
          /* Normal mode — action buttons */
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
              {buttons.filter(b => b.show).map(btn => {
                const isHovered = hoveredId === btn.id
                return (
                  <button
                    key={btn.id}
                    onClick={btn.onClick}
                    onMouseEnter={() => setHoveredId(btn.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className="neu-button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 14px',
                      fontSize: 13,
                      fontWeight: 500,
                      color: isHovered ? btn.accentColor : '#e8e8f0',
                      boxShadow: isHovered
                        ? `0 0 16px ${btn.accentColor}40, 6px 6px 12px #111116, -6px -6px 12px #2c2c35`
                        : '6px 6px 12px #111116, -6px -6px 12px #2c2c35',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {btn.icon}
                    {btn.label}
                  </button>
                )
              })}

              {/* Overflow menu — Unsubscribe Only */}
              {unsubscribableCount > 0 && onUnsubscribeOnly && (
                <div data-overflow-menu style={{ position: 'relative' }}>
                  <button
                    onClick={() => setShowOverflow(v => !v)}
                    className="neu-button"
                    aria-label="More actions"
                    aria-haspopup="true"
                    aria-expanded={showOverflow}
                    style={{
                      width: 36, height: 36,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#8888a0', fontSize: 20, letterSpacing: 1,
                    }}
                  >
                    ⋯
                  </button>
                  {showOverflow && (
                    <div
                      className="neu-card"
                      style={{
                        position: 'absolute',
                        bottom: 44,
                        right: 0,
                        padding: '6px 0',
                        minWidth: 180,
                        zIndex: 20,
                        borderRadius: 12,
                      }}
                    >
                      <button
                        onClick={() => { setShowOverflow(false); onUnsubscribeOnly() }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '10px 16px', width: '100%',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          fontSize: 13, color: '#e8e8f0', textAlign: 'left',
                        }}
                      >
                        <BellOff size={14} color="#a55eea" strokeWidth={1.75} />
                        Unsubscribe Only
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {hasUnsubscribable && unsubscribableCount < selectedCount && (
              <p style={{ fontSize: 12, color: '#8888a0', textAlign: 'center' }}>
                {selectedCount - unsubscribableCount} sender{selectedCount - unsubscribableCount !== 1 ? 's' : ''} won&apos;t be auto-unsubscribed — emails will still be deleted
              </p>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}
