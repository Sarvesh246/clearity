'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useScanRunner } from '@/hooks/useScanRunner'
import { motion } from 'framer-motion'
import {
  Settings, Mail, ScanLine, AlertCircle,
  Trash2, HelpCircle, ShieldCheck, RefreshCw, ArrowRight
} from 'lucide-react'
import Link from 'next/link'
import HealthScoreCircle from '@/components/HealthScoreCircle'
import StatCard from '@/components/StatCard'
import { formatCount } from '@/lib/utils'
import type { HealthScore } from '@/lib/scoring'

interface Props {
  firstName: string
  lastScanAt: string | null
  health: HealthScore | null
  junkCount: number
  unsureCount: number
  safeCount: number
  junkEmailTotal: number
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins  < 1)  return 'just now'
  if (hours < 1)  return `${mins} minute${mins === 1 ? '' : 's'} ago`
  if (days  < 1)  return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.1, duration: 0.4, ease: [0.4, 0, 0.2, 1] as const },
  }),
}

export default function DashboardContent({
  firstName, lastScanAt, health, junkCount, unsureCount, safeCount, junkEmailTotal,
}: Props) {
  const router = useRouter()
  const [dots, setDots] = useState('.')
  const {
    isScanning: isRescanning,
    isPaused,
    progress,
    scanError,
    startScan,
    cancelScan,
    setScanError,
  } = useScanRunner({
    onComplete: () => router.refresh(),
    onAuthExpired: () => router.push('/?message=gmail_auth_expired'),
  })

  useEffect(() => {
    if (!isRescanning) return
    const id = setInterval(() => setDots(d => d.length >= 3 ? '.' : d + '.'), 500)
    return () => clearInterval(id)
  }, [isRescanning])

  function startRescan(opts: { full?: boolean; resume?: boolean } = {}) {
    setScanError(false)
    startScan(opts)
  }

  const isListing = isRescanning && progress.list_complete === false
  const pct = isListing
    ? 0
    : progress.total > 0
      ? Math.min(99, Math.round((progress.scanned / progress.total) * 100))
      : 0
  const hasScan = health !== null

  return (
    <div className="w-full max-w-[672px] flex flex-col gap-5 pb-8">
      {/* Header */}
      <motion.div
        custom={0} initial="hidden" animate="visible" variants={cardVariants}
        className="flex items-start justify-between"
      >
        <div className="flex flex-col gap-1">
          <h1
            className="text-2xl font-bold text-white"
            style={{ letterSpacing: '-0.03em' }}
          >
            Hey, {firstName} 👋
          </h1>
          <p className="text-sm" style={{ color: '#8888a0' }}>
            {lastScanAt
              ? `Last scan: ${formatTimeAgo(lastScanAt)}`
              : 'No scan yet — scan to see your health score'}
          </p>
        </div>
        <Link
          href="/dashboard/settings"
          className="neu-button flex items-center justify-center"
          style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0 }}
        >
          <Settings size={18} strokeWidth={1.75} style={{ color: '#8888a0' }} />
        </Link>
      </motion.div>

      {/* Rescan in-progress card */}
      {isRescanning && (
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="neu-card flex flex-col gap-4"
        >
          <div className="flex items-center gap-3">
            <div className="neu-inset flex items-center justify-center flex-shrink-0"
              style={{ width: 40, height: 40, borderRadius: 12 }}>
              <ScanLine size={18} color="#45aaf2" strokeWidth={1.75} />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Rescanning inbox</p>
              <p className="text-xs" style={{ color: '#8888a0' }}>{progress.phase}{dots}</p>
            </div>
          </div>
          <div className="neu-inset overflow-hidden" style={{ height: 8, borderRadius: 99 }}>
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
              <div style={{
                width: `${pct}%`, height: '100%', background: '#45aaf2',
                borderRadius: 99, transition: 'width 0.4s ease', minWidth: pct > 0 ? 8 : 0,
              }} />
            )}
          </div>
          {progress.total > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-xs" style={{ color: '#555568' }}>
                {isListing
                  ? `${progress.total.toLocaleString()} emails found so far`
                  : `${pct}% — ${progress.scanned.toLocaleString()} / ${progress.total.toLocaleString()} emails`}
              </p>
              <button
                onClick={cancelScan}
                className="neu-button"
                style={{ padding: '4px 10px', fontSize: 11, color: '#8888a0' }}
                aria-label="Cancel scan"
              >
                Cancel
              </button>
            </div>
          )}
          {scanError && (
            <div className="flex items-center gap-2" style={{ color: '#e84141' }}>
              <AlertCircle size={16} strokeWidth={1.75} />
              <span className="text-sm font-medium">Scan failed. Please try again.</span>
            </div>
          )}
        </motion.div>
      )}

      {/* Health score card */}
      <motion.div
        custom={1} initial="hidden" animate="visible" variants={cardVariants}
        className="neu-card flex flex-col items-center gap-2 py-8"
      >
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#555568' }}>
          Inbox Health Score
        </p>
        <HealthScoreCircle
          score={hasScan ? health!.score : null}
          color={hasScan ? health!.color : '#555568'}
          label={hasScan ? health!.label : null}
          pulse={hasScan ? health!.pulse : false}
        />
        {!hasScan && (
          <p className="text-sm text-center" style={{ color: '#8888a0' }}>
            Scan your inbox to see your health score
          </p>
        )}
      </motion.div>

      {/* Stat cards */}
      <motion.div
        custom={2} initial="hidden" animate="visible" variants={cardVariants}
        className="flex gap-3"
      >
        <StatCard
          icon={<Trash2 size={18} strokeWidth={1.75} />}
          value={hasScan ? formatCount(junkCount) : '—'}
          label="Junk senders"
          color="#e84141"
        />
        <StatCard
          icon={<HelpCircle size={18} strokeWidth={1.75} />}
          value={hasScan ? formatCount(unsureCount) : '—'}
          label="Unsure"
          color="#ffb142"
        />
        <StatCard
          icon={<ShieldCheck size={18} strokeWidth={1.75} />}
          value={hasScan ? formatCount(safeCount) : '—'}
          label="Safe senders"
          color="#26de81"
        />
      </motion.div>

      {/* Summary card */}
      <motion.div
        custom={3} initial="hidden" animate="visible" variants={cardVariants}
        className="neu-card flex items-center gap-4"
      >
        <div className="neu-inset flex items-center justify-center flex-shrink-0"
          style={{ width: 44, height: 44, borderRadius: 12 }}>
          <Mail size={20} color="#45aaf2" strokeWidth={1.75} />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs font-medium" style={{ color: '#8888a0' }}>
            Total emails from junk senders
          </span>
          <span
            className="text-2xl font-bold tabular-nums"
            style={{ color: '#45aaf2', letterSpacing: '-0.03em' }}
          >
            {hasScan ? formatCount(junkEmailTotal) : '—'}
          </span>
        </div>
      </motion.div>

      {/* CTAs */}
      <motion.div
        custom={4} initial="hidden" animate="visible" variants={cardVariants}
        className="flex flex-col gap-3"
      >
        {hasScan ? (
          <>
            <Link
              href="/dashboard/senders"
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-semibold text-base"
              style={{ boxShadow: '0 0 20px #45aaf240, 6px 6px 12px #111116, -6px -6px 12px #2c2c35' }}
            >
              <ArrowRight size={18} strokeWidth={2} color="#45aaf2" />
              Review &amp; Clean Inbox
            </Link>
            {isPaused && progress.total > 0 && progress.scanned < progress.total && (
              <button
                onClick={() => startRescan({ resume: true })}
                disabled={isRescanning}
                className="neu-button w-full flex items-center justify-center gap-2 px-6 py-3 font-medium text-sm"
                style={{ color: '#45aaf2' }}
              >
                <RefreshCw size={16} strokeWidth={1.75} />
                Continue Scan ({progress.scanned.toLocaleString()} / {progress.total.toLocaleString()})
              </button>
            )}
            <button
              onClick={() => startRescan({ full: false })}
              disabled={isRescanning}
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-3 font-medium text-sm"
              style={{ color: '#8888a0' }}
            >
              <RefreshCw size={16} strokeWidth={1.75} />
              {isRescanning ? 'Syncing…' : 'Sync New Emails'}
            </button>
            <button
              onClick={() => startRescan({ full: true })}
              disabled={isRescanning}
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-2 font-medium text-xs"
              style={{ color: '#555568' }}
            >
              Full rescan (slow — 145k+ emails)
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => startRescan({ full: true })}
              disabled={isRescanning}
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-semibold text-base"
              style={{ boxShadow: '0 0 20px #45aaf240, 6px 6px 12px #111116, -6px -6px 12px #2c2c35' }}
            >
              <ScanLine size={18} strokeWidth={1.75} color="#45aaf2" />
              {isRescanning ? 'Scanning…' : isPaused ? 'Start New Scan' : 'Scan My Inbox'}
            </button>
            {isPaused && progress.total > 0 && progress.scanned < progress.total && (
              <button
                onClick={() => startRescan({ resume: true })}
                disabled={isRescanning}
                className="neu-button w-full flex items-center justify-center gap-2 px-6 py-3 font-medium text-sm"
                style={{ color: '#45aaf2' }}
              >
                <RefreshCw size={16} strokeWidth={1.75} />
                Continue Scan ({progress.scanned.toLocaleString()} / {progress.total.toLocaleString()})
              </button>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}
