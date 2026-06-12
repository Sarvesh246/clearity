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

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError()
}

const CHUNK_SIZE = 100
const CHUNK_DELAY_MS = 2000
const MAX_RETRIES = 3

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchChunkWithRetry(
  gmail: gmail_v1.Gmail,
  ids: string[],
  attempt = 0
): Promise<gmail_v1.Schema$Message[]> {
  try {
    const results = await Promise.all(
      ids.map(id =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
          fields: 'id,labelIds,payload/headers',
        }).then(r => r.data)
      )
    )
    return results
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 429 && attempt < MAX_RETRIES) {
      await sleep(CHUNK_DELAY_MS * Math.pow(2, attempt))
      return fetchChunkWithRetry(gmail, ids, attempt + 1)
    }
    throw err
  }
}

export async function scanInbox(
  gmail: gmail_v1.Gmail,
  options: ScannerOptions
): Promise<ScanResult> {
  const { onProgress, signal } = options

  // Step 1: Collect all message IDs via paginated messages.list
  await onProgress(0, 0, 'Fetching email list...')

  const allIds: string[] = []
  let pageToken: string | undefined = undefined

  do {
    const listRes: { data: gmail_v1.Schema$ListMessagesResponse } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      pageToken,
      fields: 'messages/id,nextPageToken',
    })
    const page: gmail_v1.Schema$ListMessagesResponse = listRes.data
    if (page.messages) {
      for (const m of page.messages) {
        if (m.id) allIds.push(m.id)
      }
    }
    pageToken = page.nextPageToken ?? undefined
    await onProgress(0, allIds.length, 'Fetching email list...')
    checkCancelled(signal)
  } while (pageToken)

  const total = allIds.length

  // Step 2: Fetch metadata in chunks of 100
  const senderMap = new Map<string, SenderData>()
  let scanned = 0
  const startedAt = Date.now()

  for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
    checkCancelled(signal)
    const chunk = allIds.slice(i, i + CHUNK_SIZE)
    const messages = await fetchChunkWithRetry(gmail, chunk)

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? []
      const labelIds = msg.labelIds ?? []

      const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
      const unsubHeader = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe')?.value
      const unsubPost = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe-post')?.value

      const parsed = parseFrom(fromHeader)
      if (!parsed) continue

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

    scanned += chunk.length

    const elapsed = Date.now() - startedAt
    const rate = scanned / Math.max(elapsed, 1)
    const etaMs = rate > 0 ? (total - scanned) / rate : 0
    const etaMins = Math.ceil(etaMs / 60_000)
    const etaText = scanned > 0 && total > 0
      ? (etaMins <= 1 ? ' · less than a min left' : ` · ~${etaMins} min left`)
      : ''
    await onProgress(scanned, total, `Reading ${scanned.toLocaleString()} / ${total.toLocaleString()} emails${etaText}`)

    if (i + CHUNK_SIZE < allIds.length) {
      await sleep(CHUNK_DELAY_MS)
      checkCancelled(signal)
    }
  }

  // Step 4: Sort by email_count desc
  const senders = Array.from(senderMap.values()).sort((a, b) => b.email_count - a.email_count)

  return { senders, totalMessages: total }
}
