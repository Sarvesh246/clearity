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

  if (
    result.error !== 'gmail_auth_expired' &&
    (result.continued || (result.error && result.continued !== false))
  ) {
    scheduleScanContinuation(user.id)
  }

  if (result.error) {
    return NextResponse.json(result, { status: 500 })
  }

  return NextResponse.json(result)
}
