import { waitUntil } from '@vercel/functions'

/** Queue the next scan chunk on the server (no open browser required). */
export function scheduleScanContinuation(userId: string): void {
  const secret = process.env.SCAN_WORKER_SECRET
  if (!secret) {
    console.warn('[scan] SCAN_WORKER_SECRET unset — background continuation disabled')
    return
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const task = fetch(`${origin}/api/scan/continue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ userId }),
  }).catch(err => console.error('[scan-worker] continuation failed', err))

  try {
    waitUntil(task)
  } catch {
    void task
  }
}
