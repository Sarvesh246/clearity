import { waitUntil } from '@vercel/functions'

export interface ScheduleContinuationOptions {
  /**
   * Wait this long before kicking the next chunk. Used on the error path so a
   * persistently failing scan retries with backoff instead of looping
   * continuation → instant failure → continuation in a tight (costly) cycle.
   */
  delayMs?: number
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Queue the next scan chunk on the server (no open browser required). */
export function scheduleScanContinuation(
  userId: string,
  options: ScheduleContinuationOptions = {}
): void {
  const secret = process.env.SCAN_WORKER_SECRET
  if (!secret) {
    console.warn('[scan] SCAN_WORKER_SECRET unset — background continuation disabled')
    return
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const task = (async () => {
    if (options.delayMs && options.delayMs > 0) await sleep(options.delayMs)
    await fetch(`${origin}/api/scan/continue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ userId }),
    })
  })().catch(err => console.error('[scan-worker] continuation failed', err))

  try {
    waitUntil(task)
  } catch {
    void task
  }
}
