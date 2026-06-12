import { gmail_v1 } from 'googleapis'
import { withGmailRetry } from './bulkActions'
import { isGmailQuotaOrRateLimit } from './gmailErrors'
import { ScanCancelledError } from '@/types'

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError()
}

/**
 * Cap pages per call so the caller persists the page token (and inserts the
 * IDs) regularly. Without this, one call could list for the entire time
 * budget and a crash/kill would lose every page fetched this invocation.
 */
const MAX_PAGES_PER_CALL = 20

export interface ListMessagesChunkResult {
  ids: string[]
  nextPageToken: string | null
  listComplete: boolean
  /** True when Gmail rate limits cut listing short — resume after a delay. */
  pausedForQuota: boolean
}

/**
 * Paginate messages.list until deadline, page cap, or no more pages.
 * Returns IDs found in this invocation only.
 */
export async function listMessageIdsChunk(
  gmail: gmail_v1.Gmail,
  options: {
    pageToken?: string | null
    deadline: number
    signal?: AbortSignal
    onProgress: (found: number) => Promise<void>
  }
): Promise<ListMessagesChunkResult> {
  const { pageToken: startToken, deadline, signal, onProgress } = options
  const ids: string[] = []
  let pageToken: string | undefined = startToken ?? undefined
  let pages = 0
  let pausedForQuota = false

  do {
    checkCancelled(signal)
    if (Date.now() >= deadline) break

    let listRes
    try {
      listRes = await withGmailRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          maxResults: 500,
          pageToken,
          fields: 'messages/id,nextPageToken',
        }), 3)
    } catch (err) {
      // Persistent rate limit: keep the pages already fetched and the token we
      // were about to use — the caller saves both and a delayed continuation
      // re-lists from exactly here instead of redoing this whole invocation.
      if (isGmailQuotaOrRateLimit(err)) {
        pausedForQuota = true
        break
      }
      throw err
    }

    const page = listRes.data
    if (page.messages) {
      for (const m of page.messages) {
        if (m.id) ids.push(m.id)
      }
    }

    pageToken = page.nextPageToken ?? undefined
    pages++
    await onProgress(ids.length)
  } while (pageToken !== undefined && Date.now() < deadline && pages < MAX_PAGES_PER_CALL)

  return {
    ids,
    nextPageToken: pageToken ?? null,
    listComplete: !pageToken && !pausedForQuota,
    pausedForQuota,
  }
}
