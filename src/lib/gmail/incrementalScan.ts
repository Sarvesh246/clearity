import { gmail_v1 } from 'googleapis'
import type { SenderData } from './scanner'
import { GmailQuotaPauseError, scanMessageIds } from './scanner'
import { withGmailRetry } from './bulkActions'
import { ScanCancelledError } from '@/types'

export interface IncrementalScanResult {
  senders: SenderData[]
  newMessageCount: number
  historyId: string
}

export async function incrementalSync(
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
  existingMap: Map<string, SenderData>,
  options: {
    onProgress: (phase: string) => Promise<void>
    signal?: AbortSignal
    /** Stop before this timestamp (Vercel time budget). */
    deadline?: number
  }
): Promise<IncrementalScanResult> {
  const { onProgress, signal, deadline } = options
  const newIds = new Set<string>()

  await onProgress('Checking for new emails...')

  let pageToken: string | undefined
  let latestHistoryId = startHistoryId

  do {
    const res = await withGmailRetry(() =>
      gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        pageToken,
        maxResults: 500,
      }), 3)

    const history = res.data.history ?? []
    for (const record of history) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) newIds.add(added.message.id)
      }
    }

    if (res.data.historyId) latestHistoryId = res.data.historyId
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  const profile = await gmail.users.getProfile({ userId: 'me' })
  if (profile.data.historyId) latestHistoryId = profile.data.historyId

  if (newIds.size === 0) {
    return {
      senders: Array.from(existingMap.values()),
      newMessageCount: 0,
      historyId: latestHistoryId,
    }
  }

  await onProgress(`Syncing ${newIds.size.toLocaleString()} new emails...`)
  const result = await scanMessageIds(gmail, Array.from(newIds), existingMap, {
    onProgress: async (scanned, total) => {
      await onProgress(`Syncing ${scanned.toLocaleString()} / ${total.toLocaleString()} new emails`)
    },
    signal,
    deadline,
  })

  // A partial sync must never be committed: the caller would upsert
  // partially-merged counts AND advance gmail_history_id past messages that
  // were never read — silently losing them (or double-counting on retry).
  // Throw instead so the whole sync is retried atomically.
  if (signal?.aborted) throw new ScanCancelledError()
  if (result.pausedForQuota || result.cursor < newIds.size) {
    throw new GmailQuotaPauseError()
  }

  return {
    senders: Array.from(existingMap.values()),
    newMessageCount: newIds.size,
    historyId: latestHistoryId,
  }
}
