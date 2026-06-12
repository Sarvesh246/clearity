import { gmail_v1 } from 'googleapis'
import { parseFrom } from './parseFrom'
import { parseUnsubscribe } from './parseUnsubscribe'
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

// Gmail: 6,000 quota units/min/user; messages.get = 20 units → max ~300/min.
// Target ~200/min (4,000 units/min) for marathon 200k scans.
const BATCH_SIZE = 20
const PARALLEL = 8
const WAVE_DELAY_MS = 500
const BATCH_DELAY_MS = 12_000
const QUOTA_RETRY_MS = 65_000
const MAX_RETRIES = 5

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError()
}

function getHttpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
    ?? (err as { status?: number; code?: number })?.status
    ?? (err as { code?: number })?.code
}

async function fetchMessageWithRetry(
  gmail: gmail_v1.Gmail,
  id: string,
  attempt = 0
): Promise<gmail_v1.Schema$Message> {
  try {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
      fields: 'id,labelIds,payload/headers',
    })
    return res.data
  } catch (err: unknown) {
    if (getHttpStatus(err) === 429 && attempt < MAX_RETRIES) {
      await sleep(QUOTA_RETRY_MS)
      return fetchMessageWithRetry(gmail, id, attempt + 1)
    }
    throw err
  }
}

async function fetchBatch(
  gmail: gmail_v1.Gmail,
  ids: string[],
  onRateLimited?: () => Promise<void>
): Promise<gmail_v1.Schema$Message[]> {
  const results: gmail_v1.Schema$Message[] = []

  for (let i = 0; i < ids.length; i += PARALLEL) {
    const wave = ids.slice(i, i + PARALLEL)
    try {
      const waveResults = await Promise.all(
        wave.map(id => fetchMessageWithRetry(gmail, id))
      )
      results.push(...waveResults)
    } catch (err: unknown) {
      if (getHttpStatus(err) === 429) {
        await onRateLimited?.()
        await sleep(QUOTA_RETRY_MS)
        i -= PARALLEL
        continue
      }
      throw err
    }
    if (i + PARALLEL < ids.length) await sleep(WAVE_DELAY_MS)
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
  let rateLimitNotified = false
  let cursor = startIndex
  const chunkEmails = new Set<string>()

  const notifyRateLimited = async () => {
    if (rateLimitNotified) return
    rateLimitNotified = true
    await onRateLimited?.()
  }

  for (let i = startIndex; i < ids.length; i += BATCH_SIZE) {
    if (Date.now() >= deadline) break
    checkCancelled(signal)

    const chunk = ids.slice(i, i + BATCH_SIZE)
    const messages = await fetchBatch(gmail, chunk, notifyRateLimited)

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? []
      const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
      const parsed = parseFrom(fromHeader)
      mergeMessageIntoSenderMap(senderMap, msg)
      if (parsed) chunkEmails.add(parsed.email)
    }

    cursor = i + chunk.length
    await onProgress(cursor, total)

    if (i + BATCH_SIZE < ids.length) {
      await sleep(BATCH_DELAY_MS)
      checkCancelled(signal)
    }
  }

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
