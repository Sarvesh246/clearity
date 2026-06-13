import type { UserSender } from '@/types'

export interface HealthScore {
  score: number
  label: 'Healthy' | 'Cluttered' | 'Messy' | 'Critical'
  color: string
  pulse: boolean
}

/**
 * Inbox health is ratio-based so a 200k inbox with 100 junk emails scores
 * differently from a 1k inbox with the same absolute junk count.
 */
export function calculateHealthScore(senders: UserSender[]): HealthScore | null {
  if (senders.length === 0) return null

  let totalEmails = 0
  let junkEmails = 0
  let unsureEmails = 0
  let totalUnread = 0
  let junkSenderCount = 0
  let unsubCount = 0

  for (const s of senders) {
    totalEmails += s.email_count
    totalUnread += s.unread_count
    if (s.is_unsubscribed) unsubCount++
    if (s.classification === 'junk') {
      junkSenderCount++
      junkEmails += s.email_count
    } else if (s.classification === 'unsure') {
      unsureEmails += s.email_count
    }
  }

  if (totalEmails === 0) return null

  const junkPct = junkEmails / totalEmails
  const unsurePct = unsureEmails / totalEmails
  const unreadPct = totalUnread / totalEmails

  let score = 100

  // Primary signal: what fraction of the inbox is junk / borderline
  score -= junkPct * 90
  score -= unsurePct * 25

  // Small reward for senders already cleaned up (capped so it can't mask junk)
  score += Math.min(unsubCount * 0.5, 8)

  // Unread load scales with inbox size, not fixed thresholds
  if (unreadPct > 0.4) score -= 18
  else if (unreadPct > 0.2) score -= 12
  else if (unreadPct > 0.1) score -= 8
  else if (unreadPct > 0.05) score -= 4

  // Extra hit when junk is spread across many senders (not just one noisy list)
  const junkSenderShare = junkSenderCount / senders.length
  if (junkSenderCount > 30 && junkSenderShare > 0.25) {
    score -= Math.min(10, junkSenderShare * 15)
  }

  score = Math.round(Math.max(0, Math.min(100, score)))

  if (score >= 80) return { score, label: 'Healthy',   color: '#26de81', pulse: false }
  if (score >= 50) return { score, label: 'Cluttered', color: '#ffb142', pulse: false }
  if (score >= 20) return { score, label: 'Messy',     color: '#e84141', pulse: false }
  return                  { score, label: 'Critical',  color: '#e84141', pulse: true  }
}
