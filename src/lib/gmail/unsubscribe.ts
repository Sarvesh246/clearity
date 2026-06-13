import { gmail_v1 } from 'googleapis'
import type { UserSender } from '@/types'
import { buildUnsubscribeEmail } from './buildUnsubscribeEmail'

export interface UnsubscribeResult {
  sender_email: string
  success: boolean
  method: 'post' | 'mailto' | 'url_get' | 'none'
  error?: string
}

async function tryOneClickPost(url: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

async function tryUrlGet(url: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Unsubscribe a sender, preferring HTTP methods over mailto.
 *
 * HTTP gives an immediate, verifiable result. A mailto, by contrast, is
 * fire-and-forget: `messages.send` succeeding only means Gmail accepted the
 * message for delivery — it can still bounce minutes later (the user then gets
 * a "message not delivered" notice). So we exhaust the sender's HTTP options
 * first and fall back to email only when there is no usable URL. Within HTTP we
 * try one-click POST (RFC 8058) then a plain GET on the same URL before
 * resorting to mailto, returning on the first method that succeeds.
 */
export async function unsubscribeSender(
  gmail: gmail_v1.Gmail,
  sender: UserSender
): Promise<UnsubscribeResult> {
  const base = { sender_email: sender.sender_email }
  let lastError: string | undefined

  // Method 1: RFC 8058 one-click POST (only when the sender advertised it)
  if (sender.unsubscribe_post && sender.unsubscribe_url) {
    try {
      await tryOneClickPost(sender.unsubscribe_url)
      return { ...base, success: true, method: 'post' }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'POST failed'
    }
  }

  // Method 2: plain GET on the unsubscribe URL — still verifiable, no bounce
  if (sender.unsubscribe_url) {
    try {
      await tryUrlGet(sender.unsubscribe_url)
      return { ...base, success: true, method: 'url_get' }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'GET failed'
    }
  }

  // Method 3: mailto — last resort, since it can bounce after we report success
  if (sender.unsubscribe_mailto) {
    try {
      const raw = buildUnsubscribeEmail(sender.unsubscribe_mailto)
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
      return { ...base, success: true, method: 'mailto' }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Send failed'
    }
  }

  if (lastError) {
    const method = sender.unsubscribe_url ? 'url_get' : 'mailto'
    return { ...base, success: false, method, error: lastError }
  }

  return { ...base, success: false, method: 'none' }
}
