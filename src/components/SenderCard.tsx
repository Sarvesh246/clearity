'use client'

import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import { ShieldCheck, Trash2 } from 'lucide-react'
import type { UserSender, Classification } from '@/types'

interface SenderCardProps {
  sender: UserSender
  isSelected: boolean
  onToggle: (email: string) => void
  onOverride?: (email: string, classification: Classification | null) => void
  overriddenAs?: Classification | null
}

const classificationColors: Record<string, { bg: string; text: string }> = {
  junk:   { bg: '#e8414133', text: '#e84141' },
  safe:   { bg: '#26de8133', text: '#26de81' },
  unsure: { bg: '#ffb14233', text: '#ffb142' },
  none:   { bg: '#a55eea33', text: '#a55eea' },
}

function getColors(classification: string | null) {
  return classificationColors[classification ?? 'none'] ?? classificationColors.none
}

export default function SenderCard({ sender, isSelected, onToggle, onOverride, overriddenAs }: SenderCardProps) {
  const colors = getColors(sender.classification)
  const avatarLetter = (sender.sender_name ?? sender.sender_email).charAt(0).toUpperCase()

  const displayName = sender.sender_name ?? sender.domain
  const unreadText = sender.unread_count > 0 ? ` · ${sender.unread_count.toLocaleString()} unread` : ''

  const [isHovered, setIsHovered] = useState(false)
  const [showMobileActions, setShowMobileActions] = useState(false)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleClick() {
    if (showMobileActions) {
      setShowMobileActions(false)
      return
    }
    onToggle(sender.sender_email)
  }

  return (
    <div
      className="neu-card"
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onTouchStart={() => {
        longPressRef.current = setTimeout(() => setShowMobileActions(true), 300)
      }}
      onTouchEnd={() => {
        if (longPressRef.current) clearTimeout(longPressRef.current)
      }}
      style={{
        padding: '14px 16px',
        cursor: 'pointer',
        position: 'relative',
        boxShadow: isSelected
          ? '0 0 0 2px #a55eea, 6px 6px 12px #111116, -6px -6px 12px #2c2c35'
          : '6px 6px 12px #111116, -6px -6px 12px #2c2c35',
        transition: 'box-shadow 0.15s ease',
      }}
    >
      {/* Classification dot */}
      {sender.classification && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: colors.text,
          }}
        />
      )}

      {/* Desktop hover + mobile long-press override buttons */}
      {(isHovered || showMobileActions) && onOverride && (
        <div
          style={{ position: 'absolute', top: 8, right: 24, display: 'flex', gap: 6, zIndex: 10 }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="neu-button"
            onClick={() => { onOverride(sender.sender_email, 'safe'); setShowMobileActions(false) }}
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}
            aria-label={`Mark ${sender.sender_name ?? sender.sender_email} as safe`}
          >
            <ShieldCheck size={13} color="#26de81" strokeWidth={1.75} />
          </button>
          <button
            className="neu-button"
            onClick={() => { onOverride(sender.sender_email, 'junk'); setShowMobileActions(false) }}
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}
            aria-label={`Mark ${sender.sender_name ?? sender.sender_email} as junk`}
          >
            <Trash2 size={13} color="#e84141" strokeWidth={1.75} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        {/* Custom checkbox with accessible role + keyboard support + scale animation */}
        <motion.div
          animate={{ scale: isSelected ? [0.88, 1] : 1 }}
          transition={{ duration: 0.12 }}
          role="checkbox"
          aria-checked={isSelected}
          aria-label={`Select ${sender.sender_name ?? sender.sender_email}`}
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              onToggle(sender.sender_email)
            }
          }}
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isSelected ? '#a55eea' : '#1a1a1e',
            boxShadow: isSelected
              ? 'none'
              : 'inset 4px 4px 8px #111116, inset -4px -4px 8px #2c2c35',
            transition: 'background 0.15s ease',
          }}
        >
          {isSelected && (
            <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
              <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </motion.div>

        {/* Avatar */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: colors.bg,
            color: colors.text,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {avatarLetter}
        </div>

        {/* Info */}
        <div className="flex flex-col gap-0.5 min-w-0" style={{ paddingRight: 16 }}>
          <span
            className="font-semibold text-white truncate"
            style={{ fontSize: 14, letterSpacing: '-0.01em' }}
          >
            {displayName}
          </span>
          <span
            className="truncate"
            style={{ fontSize: 12, color: '#8888a0' }}
          >
            {sender.sender_email}
          </span>
          <span style={{ fontSize: 12, color: '#555568' }}>
            {sender.email_count.toLocaleString()} emails{unreadText}
          </span>

          {/* Unsubscribe badge */}
          {sender.is_unsubscribed ? (
            <span
              style={{
                marginTop: 4,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: '#26de8133',
                color: '#26de81',
                borderRadius: 99,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 500,
                alignSelf: 'flex-start',
              }}
            >
              ✓ Unsubscribed
            </span>
          ) : sender.has_unsubscribe_header ? (
            <span
              style={{
                marginTop: 4,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: '#45aaf233',
                color: '#45aaf2',
                borderRadius: 99,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 500,
                alignSelf: 'flex-start',
              }}
            >
              ✉ Unsubscribe available
            </span>
          ) : null}

          {/* Override badge */}
          {overriddenAs && (
            <span
              style={{
                marginTop: 4,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: overriddenAs === 'safe' ? '#26de8122' : '#e8414122',
                color: overriddenAs === 'safe' ? '#26de81' : '#e84141',
                borderRadius: 99,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 500,
                alignSelf: 'flex-start',
              }}
            >
              {overriddenAs === 'safe' ? 'You marked safe' : 'You marked junk'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
