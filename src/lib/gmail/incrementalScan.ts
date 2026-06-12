import { gmail_v1 } from 'googleapis'
import type { SenderData } from './scanner'
import { scanMessageIds } from './scanner'

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
  }
): Promise<IncrementalScanResult> {
  const { onProgress, signal } = options
  const newIds = new Set<string>()

  await onProgress('Checking for new emails...')

  let pageToken: string | undefined
  let latestHistoryId = startHistoryId

  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      pageToken,
      maxResults: 500,
    })

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
  await scanMessageIds(gmail, Array.from(newIds), existingMap, {
    onProgress: async (scanned, total) => {
      await onProgress(`Syncing ${scanned.toLocaleString()} / ${total.toLocaleString()} new emails`)
    },
    signal,
  })

  return {
    senders: Array.from(existingMap.values()),
    newMessageCount: newIds.size,
    historyId: latestHistoryId,
  }
}
