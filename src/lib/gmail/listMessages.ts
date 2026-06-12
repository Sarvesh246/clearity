import { gmail_v1 } from 'googleapis'
import { withGmailRetry } from './bulkActions'
import { ScanCancelledError } from '@/types'

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError()
}

export interface ListMessagesChunkResult {
  ids: string[]
  nextPageToken: string | null
  listComplete: boolean
}

/**
 * Paginate messages.list until deadline or no more pages.
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

  do {
    checkCancelled(signal)
    if (Date.now() >= deadline) break

    const listRes = await withGmailRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        maxResults: 500,
        pageToken,
        fields: 'messages/id,nextPageToken',
      }), 3)

    const page = listRes.data
    if (page.messages) {
      for (const m of page.messages) {
        if (m.id) ids.push(m.id)
      }
    }

    pageToken = page.nextPageToken ?? undefined
    await onProgress(ids.length)
  } while (pageToken !== undefined && Date.now() < deadline)

  return {
    ids,
    nextPageToken: pageToken ?? null,
    listComplete: !pageToken,
  }
}
