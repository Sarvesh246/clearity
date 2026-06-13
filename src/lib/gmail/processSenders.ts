import { gmail_v1 } from 'googleapis'
import { getMessageIdsForSender } from './getMessageIds'

export interface SenderProcessResult {
  /** Senders whose emails were fully collected AND acted on (safe to finalize). */
  processedSenders: string[]
  totalSucceeded: number
  totalFailed: number
  /** True if the time budget ran out before every sender was processed. */
  timedOut: boolean
}

type GmailBatchAction = (
  gmail: gmail_v1.Gmail,
  ids: string[],
  onProgress: (processed: number) => Promise<void>
) => Promise<{ succeeded: number; failed: number }>

interface ProcessOptions {
  concurrency?: number
  /** Date.now() cutoff — stop picking up new senders once reached. */
  deadline?: number
  onSenderStart?: (email: string) => Promise<void> | void
  onSenderDone?: (email: string, globalProcessed: number) => Promise<void> | void
  /** Fired periodically with the running global email count. */
  onProgress?: (globalProcessed: number) => Promise<void> | void
  action: GmailBatchAction
}

/**
 * Collect message IDs and run a Gmail action ONE SENDER AT A TIME, interleaved.
 *
 * The old approach collected IDs for every selected sender up front and only
 * then started deleting. For thousands of senders that meant the progress bar
 * sat at 0% while a single serverless invocation tried (and on large inboxes
 * failed) to list every message before the 300s limit — losing all work.
 *
 * Here each sender is collected and acted on before moving to the next, so
 * progress advances continuously, each finished sender's work is durably
 * applied, and a time budget lets us stop cleanly with partial results saved
 * instead of being hard-killed mid-flight.
 */
export async function processSendersInterleaved(
  gmail: gmail_v1.Gmail,
  senderEmails: string[],
  opts: ProcessOptions
): Promise<SenderProcessResult> {
  const { concurrency = 3, deadline, onSenderStart, onSenderDone, onProgress, action } = opts

  let totalSucceeded = 0
  let totalFailed = 0
  let lastReported = 0
  let index = 0
  let timedOut = false
  const processedSenders: string[] = []

  async function worker(): Promise<void> {
    while (true) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true
        return
      }
      const cur = index++
      if (cur >= senderEmails.length) return
      const email = senderEmails[cur]

      await onSenderStart?.(email)

      const ids = await getMessageIdsForSender(gmail, email)
      if (ids.length > 0) {
        const res = await action(gmail, ids, async processed => {
          const global = totalSucceeded + totalFailed + processed
          if (global - lastReported >= 500) {
            lastReported = global
            await onProgress?.(global)
          }
        })
        totalSucceeded += res.succeeded
        totalFailed += res.failed
      }

      processedSenders.push(email)
      lastReported = totalSucceeded + totalFailed
      await onSenderDone?.(email, totalSucceeded + totalFailed)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, senderEmails.length) }, worker)
  )

  return { processedSenders, totalSucceeded, totalFailed, timedOut }
}
