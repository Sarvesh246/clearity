import { gmail_v1 } from 'googleapis'
import { parseFrom } from './parseFrom'
import { parseUnsubscribe } from './parseUnsubscribe'
import { isGone, isRateLimit, isTransient } from './gmailErrors'
import { ScanCancelledError } from '@/types'

export interface SenderData {
  sender_email: string
  sender_name: string | null
  domain: string
  email_count: number
  unread_count: number
  has_unsubscribe_header: boolean
  unsubscribe_mailto: string | null
  unsubscribe_url: string | null
  unsubscribe_post: boolean
  gmail_labels: string[]
}

export interface ScanResult {
  senders: SenderData[]
  totalMessages: number
}

export interface ScannerOptions {
  onProgress: (scanned: number, total: number, phase: string) => Promise<void>
  signal?: AbortSignal
}

export interface ScanMessageIdsOptions {
  onProgress: (scanned: number, total: number) => Promise<void>
  signal?: AbortSignal
  onRateLimited?: () => Promise<void>
  /** Stop before this timestamp (for Vercel time limits). */
  deadline?: number
  startIndex?: number
}

/** ~4.5 min per Vercel invocation — leave headroom under the 5 min limit. */
export const CHUNK_TIME_BUDGET_MS = 270_000

// Gmail quota reality (per the official "Usage limits" table):
//   • Per-user rate limit: 250 quota units / user / SECOND (a moving average).
//   • messages.get = 5 units → ceiling ≈ 50 msg/sec/user.
// We pace adaptively well under that (targetRps × 5 units/sec) so a 200k scan
// finishes in ~2–3 hours instead of hammering the limit or crawling for a day.
const PARALLEL = 10            // concurrent messages.get per wave
const START_RPS = 24          // ~120 units/sec — safe starting rate
const MIN_RPS = 8             // floor after repeated 429s
const MAX_RPS = 40            // ~200 units/sec — ceiling we ramp toward
const RAMP_AFTER_WAVES = 6    // clean waves before nudging the rate up
const QUOTA_BACKOFF_MS = 20_000
const TRANSIENT_RETRY_MS = 2_000
const MAX_TRANSIENT_RETRIES = 3
const PROGRESS_EVERY = 200    // throttle DB progress writes

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError()
}

/**
 * Adaptive token-rate controller. Stays just below Gmail's per-user limit:
 * backs off hard on 429/rate signals, then gently ramps back up.
 */
class AdaptiveThrottle {
  rps = START_RPS
  private streak = 0

  /** Target wall-clock duration for a wave of `PARALLEL` requests. */
  waveIntervalMs() {
    return (PARALLEL / this.rps) * 1000
  }

  backoffMs() {
    return QUOTA_BACKOFF_MS
  }

  onCleanWave() {
    this.streak++
    if (this.streak >= RAMP_AFTER_WAVES) {
      this.rps = Math.min(MAX_RPS, this.rps + 2)
      this.streak = 0
    }
  }

  onRateLimit() {
    this.rps = Math.max(MIN_RPS, Math.floor(this.rps / 2))
    this.streak = 0
  }
}

interface FetchOutcome {
  message: gmail_v1.Schema$Message | null  // null = permanently gone (skip)
}

/** Fetch one message; retry transient 5xx; surface rate-limit/gone via throw/null. */
async function fetchMessageOnce(
  gmail: gmail_v1.Gmail,
  id: string,
  attempt = 0
): Promise<FetchOutcome> {
  try {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
      fields: 'id,labelIds,payload/headers',
    })
    return { message: res.data }
  } catch (err: unknown) {
    if (isGone(err)) return { message: null }
    if (isTransient(err) && attempt < MAX_TRANSIENT_RETRIES) {
      await sleep(TRANSIENT_RETRY_MS * (attempt + 1))
      return fetchMessageOnce(gmail, id, attempt + 1)
    }
    throw err  // rate-limit and unexpected errors bubble to the wave handler
  }
}

/**
 * Fetch a slice of IDs using the adaptive throttle. Rate-limited requests are
 * retried (only the failed ones); permanently-gone messages are skipped.
 */
async function fetchBatch(
  gmail: gmail_v1.Gmail,
  ids: string[],
  throttle: AdaptiveThrottle,
  signal?: AbortSignal,
  onRateLimited?: () => Promise<void>
): Promise<gmail_v1.Schema$Message[]> {
  const results: gmail_v1.Schema$Message[] = []

  for (let i = 0; i < ids.length; i += PARALLEL) {
    let pending = ids.slice(i, i + PARALLEL)
    let rateLimitedThisWave = false

    while (pending.length > 0) {
      checkCancelled(signal)
      const waveStart = Date.now()
      const settled = await Promise.allSettled(
        pending.map(id => fetchMessageOnce(gmail, id))
      )

      const retry: string[] = []
      for (let k = 0; k < settled.length; k++) {
        const outcome = settled[k]
        if (outcome.status === 'fulfilled') {
          if (outcome.value.message) results.push(outcome.value.message)
          // null → message gone, skip silently
        } else if (isRateLimit(outcome.reason)) {
          retry.push(pending[k])
        } else {
          throw outcome.reason
        }
      }

      if (retry.length === 0) {
        if (!rateLimitedThisWave) throttle.onCleanWave()
        const remaining = throttle.waveIntervalMs() - (Date.now() - waveStart)
        if (remaining > 0 && i + PARALLEL < ids.length) await sleep(remaining)
        pending = []
      } else {
        rateLimitedThisWave = true
        throttle.onRateLimit()
        await onRateLimited?.()
        await sleep(throttle.backoffMs())
        pending = retry
      }
    }
  }

  return results
}

export function mergeMessageIntoSenderMap(
  senderMap: Map<string, SenderData>,
  msg: gmail_v1.Schema$Message
): void {
  const headers = msg.payload?.headers ?? []
  const labelIds = msg.labelIds ?? []

  const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
  const unsubHeader = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe')?.value
  const unsubPost = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe-post')?.value

  const parsed = parseFrom(fromHeader)
  if (!parsed) return

  const { email, name, domain } = parsed
  const isUnread = labelIds.includes('UNREAD')

  const categoryLabels = labelIds.filter(l =>
    l.startsWith('CATEGORY_') || ['INBOX', 'SENT', 'SPAM', 'TRASH'].includes(l)
  )

  if (senderMap.has(email)) {
    const existing = senderMap.get(email)!
    existing.email_count++
    if (isUnread) existing.unread_count++
    if (!existing.has_unsubscribe_header && unsubHeader) {
      existing.has_unsubscribe_header = true
      const { mailto, url } = parseUnsubscribe(unsubHeader)
      existing.unsubscribe_mailto = mailto
      existing.unsubscribe_url = url
      existing.unsubscribe_post = !!unsubPost
    }
    for (const label of categoryLabels) {
      if (!existing.gmail_labels.includes(label)) {
        existing.gmail_labels.push(label)
      }
    }
  } else {
    let unsubscribeMail: string | null = null
    let unsubscribeUrl: string | null = null
    let hasUnsub = false
    let hasUnsubPost = false

    if (unsubHeader) {
      hasUnsub = true
      const { mailto, url } = parseUnsubscribe(unsubHeader)
      unsubscribeMail = mailto
      unsubscribeUrl = url
      hasUnsubPost = !!unsubPost
    }

    senderMap.set(email, {
      sender_email: email,
      sender_name: name,
      domain,
      email_count: 1,
      unread_count: isUnread ? 1 : 0,
      has_unsubscribe_header: hasUnsub,
      unsubscribe_mailto: unsubscribeMail,
      unsubscribe_url: unsubscribeUrl,
      unsubscribe_post: hasUnsubPost,
      gmail_labels: [...categoryLabels],
    })
  }
}

export async function listAllMessageIds(
  gmail: gmail_v1.Gmail,
  onProgress: (scanned: number, total: number, phase: string) => Promise<void>,
  signal?: AbortSignal
): Promise<string[]> {
  await onProgress(0, 0, 'Fetching email list...')

  const allIds: string[] = []
  let pageToken: string | undefined

  do {
    checkCancelled(signal)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      pageToken,
      fields: 'messages/id,nextPageToken',
    })
    const page = listRes.data
    if (page.messages) {
      for (const m of page.messages) {
        if (m.id) allIds.push(m.id)
      }
    }
    pageToken = page.nextPageToken ?? undefined
    await onProgress(0, allIds.length, `Fetching email list… ${allIds.length.toLocaleString()} found`)
  } while (pageToken)

  return allIds
}

export interface ScanMessageIdsResult {
  /** Index within the provided ids array (not global). */
  cursor: number
  chunkSenders: SenderData[]
}

/**
 * Scan message IDs into senderMap. Returns progress within ids[] and senders touched this run.
 */
export async function scanMessageIds(
  gmail: gmail_v1.Gmail,
  ids: string[],
  senderMap: Map<string, SenderData>,
  options: ScanMessageIdsOptions
): Promise<ScanMessageIdsResult> {
  const {
    onProgress,
    signal,
    onRateLimited,
    deadline = Number.POSITIVE_INFINITY,
    startIndex = 0,
  } = options

  const total = ids.length
  let cursor = startIndex
  const chunkEmails = new Set<string>()
  const throttle = new AdaptiveThrottle()

  let lastReported = startIndex
  try {
    for (let i = startIndex; i < ids.length; i += PARALLEL) {
      if (Date.now() >= deadline) break
      checkCancelled(signal)

      const wave = ids.slice(i, i + PARALLEL)
      const messages = await fetchBatch(gmail, wave, throttle, signal, onRateLimited)

      for (const msg of messages) {
        const headers = msg.payload?.headers ?? []
        const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
        const parsed = parseFrom(fromHeader)
        mergeMessageIntoSenderMap(senderMap, msg)
        if (parsed) chunkEmails.add(parsed.email)
      }

      cursor = i + wave.length
      if (cursor - lastReported >= PROGRESS_EVERY || cursor >= ids.length) {
        lastReported = cursor
        await onProgress(cursor, total)
      }
    }
  } catch (err) {
    // User cancelled — return partial progress so the caller can upsert senders
    // for everything read so far in this slice (don't throw away mid-chunk work).
    if (!(err instanceof ScanCancelledError)) throw err
  }

  if (cursor !== lastReported) await onProgress(cursor, total)

  const chunkSenders = [...chunkEmails]
    .map(email => senderMap.get(email))
    .filter((s): s is SenderData => !!s)

  return { cursor, chunkSenders }
}

/** Legacy single-request scan — prefer chunked scan via /api/scan for large inboxes. */
export async function scanInbox(
  gmail: gmail_v1.Gmail,
  options: ScannerOptions
): Promise<ScanResult> {
  const { onProgress, signal } = options
  const allIds = await listAllMessageIds(gmail, onProgress, signal)
  const total = allIds.length
  const senderMap = new Map<string, SenderData>()
  const startedAt = Date.now()

  const { cursor: done } = await scanMessageIds(gmail, allIds, senderMap, {
    signal,
    onRateLimited: async () => {
      await onProgress(0, total, 'Gmail rate limit — waiting a moment...')
    },
    onProgress: async (scanned) => {
      const elapsed = Date.now() - startedAt
      const rate = scanned / Math.max(elapsed, 1)
      const etaMs = rate > 0 ? (total - scanned) / rate : 0
      const etaMins = Math.ceil(etaMs / 60_000)
      const etaText = scanned > 0 && total > 0
        ? (etaMins <= 1 ? ' · less than a min left' : ` · ~${etaMins} min left`)
        : ''
      await onProgress(
        scanned,
        total,
        `Reading ${scanned.toLocaleString()} / ${total.toLocaleString()} emails${etaText}`
      )
    },
  })
  void done

  const senders = Array.from(senderMap.values()).sort((a, b) => b.email_count - a.email_count)
  return { senders, totalMessages: total }
}
