import { gmail_v1 } from 'googleapis'
import type { UserSender } from '@/types'
import { buildUnsubscribeEmail } from './buildUnsubscribeEmail'

export interface UnsubscribeResult {
  sender_email: string
  success: boolean
  method: 'post' | 'mailto' | 'url_get' | 'none'
  error?: string
}

export async function unsubscribeSender(
  gmail: gmail_v1.Gmail,
  sender: UserSender
): Promise<UnsubscribeResult> {
  const base = { sender_email: sender.sender_email }

  // Method 1: RFC 8058 one-click POST
  if (sender.unsubscribe_post && sender.unsubscribe_url) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const res = await fetch(sender.unsubscribe_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { ...base, success: true, method: 'post' }
    } catch (err) {
      return { ...base, success: false, method: 'post', error: err instanceof Error ? err.message : 'POST failed' }
    }
  }

  // Method 2: mailto
  if (sender.unsubscribe_mailto) {
    try {
      const raw = buildUnsubscribeEmail(sender.unsubscribe_mailto)
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
      return { ...base, success: true, method: 'mailto' }
    } catch (err) {
      return { ...base, success: false, method: 'mailto', error: err instanceof Error ? err.message : 'Send failed' }
    }
  }

  // Method 3: URL GET
  if (sender.unsubscribe_url) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      await fetch(sender.unsubscribe_url, { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      return { ...base, success: true, method: 'url_get' }
    } catch (err) {
      return { ...base, success: false, method: 'url_get', error: err instanceof Error ? err.message : 'GET failed' }
    }
  }

  return { ...base, success: false, method: 'none' }
}
