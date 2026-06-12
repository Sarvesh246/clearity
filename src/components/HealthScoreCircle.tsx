'use client'

import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

interface Props {
  score: number | null
  color: string
  label: string | null
  pulse?: boolean
}

const RADIUS = 52
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function HealthScoreCircle({ score, color, label, pulse = false }: Props) {
  const circleRef = useRef<SVGCircleElement>(null)

  useEffect(() => {
    const el = circleRef.current
    if (!el || score === null) return
    // Start at empty, then animate to target
    el.style.strokeDashoffset = String(CIRCUMFERENCE)
    const target = CIRCUMFERENCE * (1 - score / 100)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.strokeDashoffset = String(target)
      })
    })
  }, [score])

  const inner = (
    <svg viewBox="0 0 120 120" width="160" height="160" style={{ display: 'block' }}>
      {/* Track ring */}
      <circle
        cx="60" cy="60" r={RADIUS}
        fill="none"
        stroke="#2c2c35"
        strokeWidth="8"
      />
      {/* Score ring */}
      <circle
        ref={circleRef}
        cx="60" cy="60" r={RADIUS}
        fill="none"
        stroke={score !== null ? color : 'transparent'}
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE}
        transform="rotate(-90 60 60)"
        style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)' }}
      />
      {/* Score number */}
      <text
        x="60" y="56"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={score !== null ? color : '#555568'}
        fontSize={score !== null ? '28' : '32'}
        fontWeight="700"
        fontFamily="'Space Grotesk', sans-serif"
        letterSpacing="-1"
      >
        {score !== null ? score : '?'}
      </text>
      {/* Label */}
      {label && (
        <text
          x="60" y="76"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#8888a0"
          fontSize="10"
          fontWeight="500"
          fontFamily="'Space Grotesk', sans-serif"
          letterSpacing="0.5"
        >
          {label.toUpperCase()}
        </text>
      )}
    </svg>
  )

  if (pulse) {
    return (
      <motion.div
        animate={{ scale: [1, 1.03, 1] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      >
        {inner}
      </motion.div>
    )
  }

  return inner
}
