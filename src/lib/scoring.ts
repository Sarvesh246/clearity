import type { UserSender } from '@/types'

export interface HealthScore {
  score: number
  label: 'Healthy' | 'Cluttered' | 'Messy' | 'Critical'
  color: string
  pulse: boolean
}

export function calculateHealthScore(senders: UserSender[]): HealthScore | null {
  if (senders.length === 0) return null

  const junkCount   = senders.filter(s => s.classification === 'junk').length
  const unsureCount = senders.filter(s => s.classification === 'unsure').length
  const unsubCount  = senders.filter(s => s.is_unsubscribed).length
  const totalUnread = senders.reduce((sum, s) => sum + s.unread_count, 0)

  let score = 100
  score -= junkCount   * 2
  score -= unsureCount * 1
  score += unsubCount  * 1

  if (totalUnread > 5000)      score -= 20
  else if (totalUnread > 1000) score -= 10

  if (junkCount > 50) score -= 15

  score = Math.max(0, Math.min(100, score))

  if (score >= 80) return { score, label: 'Healthy',   color: '#26de81', pulse: false }
  if (score >= 50) return { score, label: 'Cluttered', color: '#ffb142', pulse: false }
  if (score >= 20) return { score, label: 'Messy',     color: '#e84141', pulse: false }
  return                  { score, label: 'Critical',  color: '#e84141', pulse: true  }
}
