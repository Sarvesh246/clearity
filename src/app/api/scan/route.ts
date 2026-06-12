import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runScanChunk } from '@/lib/scan/runScanChunk'
import { scheduleScanContinuation } from '@/lib/scan/scheduleContinuation'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const result = await runScanChunk(user.id, {
      forceFull: body.full === true,
      resume: body.resume === true,
    })

    if (result.skipped) {
      return NextResponse.json({ ok: true, skipped: true })
    }

    if (result.error === 'gmail_auth_expired') {
      return NextResponse.json(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired — sign in again to continue' },
        { status: 401 }
      )
    }

    if (result.error && result.continued !== false) {
      scheduleScanContinuation(user.id, { delayMs: 30_000 })
    } else if (result.continued) {
      // Quota pause: wait for Gmail's per-minute quota window to roll over
      // before the next chunk, instead of immediately hitting the limit again.
      scheduleScanContinuation(user.id, result.quotaPaused ? { delayMs: 45_000 } : {})
    }

    if (result.error) {
      return NextResponse.json(result, { status: 500 })
    }

    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scan failed'
    console.error('[scan] unhandled error:', message)
    return NextResponse.json({ error: message, continued: false }, { status: 500 })
  }
}
