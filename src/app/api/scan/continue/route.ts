import { NextResponse } from 'next/server'
import { runScanChunk } from '@/lib/scan/runScanChunk'
import { scheduleScanContinuation } from '@/lib/scan/scheduleContinuation'

export const maxDuration = 300

function verifyWorkerAuth(req: Request): boolean {
  const secret = process.env.SCAN_WORKER_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization')
  return auth === `Bearer ${secret}`
}

export async function POST(req: Request) {
  if (!verifyWorkerAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { userId } = await req.json().catch(() => ({}))
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId required' }, { status: 400 })
  }

  try {
    const result = await runScanChunk(userId, { continuation: true })

    if (result.skipped) {
      return NextResponse.json({ ok: true, skipped: true })
    }

    if (result.error === 'gmail_auth_expired') {
      return NextResponse.json({ error: 'gmail_auth_expired' }, { status: 401 })
    }

    if (result.error && result.continued !== false) {
      scheduleScanContinuation(userId, { delayMs: 30_000 })
    } else if (result.continued) {
      // Quota pause: wait for Gmail's per-minute quota window to roll over
      // before the next chunk, instead of immediately hitting the limit again.
      scheduleScanContinuation(userId, result.quotaPaused ? { delayMs: 45_000 } : {})
    }

    if (result.error) {
      return NextResponse.json(result, { status: 500 })
    }

    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scan failed'
    console.error('[scan/continue] unhandled error:', message)
    return NextResponse.json({ error: message, continued: false }, { status: 500 })
  }
}
