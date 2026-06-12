import { gmail_v1 } from 'googleapis'
import { isRateLimit, isTransient } from './gmailErrors'

export type BulkActionProgress = (processed: number, total: number) => Promise<void>

export async function withGmailRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err
      if (isRateLimit(err)) {
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)))
        continue
      }
      if (isTransient(err) && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
  throw lastError
}

async function batchModifyChunked(
  gmail: gmail_v1.Gmail,
  ids: string[],
  payload: { addLabelIds?: string[]; removeLabelIds?: string[] },
  onProgress: BulkActionProgress,
  chunkSize = 1000
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0
  let failed = 0

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    try {
      await withGmailRetry(() =>
        gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: { ids: chunk, ...payload },
        })
      )
      succeeded += chunk.length
    } catch {
      failed += chunk.length
    }
    await onProgress(succeeded + failed, ids.length)
  }

  return { succeeded, failed }
}

export async function trashMessages(
  gmail: gmail_v1.Gmail,
  ids: string[],
  onProgress: BulkActionProgress
): Promise<{ succeeded: number; failed: number }> {
  return batchModifyChunked(gmail, ids, { addLabelIds: ['TRASH'] }, onProgress)
}

export async function markAsRead(
  gmail: gmail_v1.Gmail,
  ids: string[],
  onProgress: BulkActionProgress
): Promise<{ succeeded: number; failed: number }> {
  return batchModifyChunked(gmail, ids, { removeLabelIds: ['UNREAD'] }, onProgress)
}

export async function archiveMessages(
  gmail: gmail_v1.Gmail,
  ids: string[],
  onProgress: BulkActionProgress
): Promise<{ succeeded: number; failed: number }> {
  return batchModifyChunked(gmail, ids, { removeLabelIds: ['INBOX'] }, onProgress)
}
