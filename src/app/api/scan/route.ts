import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runScanChunk } from '@/lib/scan/runScanChunk'
import { scheduleScanContinuation } from '@/lib/scan/scheduleContinuation'
import { scanJson } from '@/lib/api/scanResponse'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return scanJson({ error: 'Unauthorized' }, 401)
  }

  try {
    const body = await request.json().catch(() => ({}))
    const result = await runScanChunk(user.id, {
      forceFull: body.full === true,
      resume: body.resume === true,
    })

    if (result.skipped) {
      return scanJson({ ok: true, skipped: true })
    }

    if (result.error === 'gmail_auth_expired') {
      return scanJson(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired — sign in again to continue' },
        401
      )
    }

    // Recoverable pauses/errors use 200 so browsers never cache a replayable 500.
    // Background recovery is driven by scheduleScanContinuation — not client spam.
    if (result.error && result.continued !== false) {
      scheduleScanContinuation(user.id, { delayMs: 30_000 })
      return scanJson({ ok: false, ...result })
    }

    if (result.continued) {
      scheduleScanContinuation(user.id, result.quotaPaused ? { delayMs: 45_000 } : {})
      return scanJson({ ok: true, ...result })
    }

    if (result.error) {
      return scanJson({ ok: false, ...result }, 500)
    }

    return scanJson({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scan failed'
    console.error('[scan] unhandled error:', message)
    return scanJson({ ok: false, error: message, continued: false }, 500)
  }
}
