import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { scheduleScanContinuation } from '@/lib/scan/scheduleContinuation'
import { hasIncompleteScan } from '@/lib/scan/scanState'

export const maxDuration = 60

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function verifyCronAuth(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

/** Safety net: resume scans that stalled (tab closed, worker timeout, etc.). */
export async function GET(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SCAN_WORKER_SECRET) {
    return NextResponse.json({ error: 'SCAN_WORKER_SECRET not configured' }, { status: 503 })
  }

  const admin = adminClient()
  const staleBefore = new Date(Date.now() - 3 * 60 * 1000).toISOString()
  const lockStaleBefore = new Date(Date.now() - 6 * 60 * 1000).toISOString()

  // 'error' rows are included because a chunk failure ends the waitUntil chain
  // when its delayed retry also dies — without the cron, those scans would
  // strand despite the UI promising "will resume automatically".
  const { data: jobs, error } = await admin
    .from('scan_jobs')
    .select('user_id, status, phase, scanned, total, cursor, list_complete, list_page_token, updated_at, chunk_locked_at')
    .in('status', ['scanning', 'error'])
    .is('action_type', null)
    .lt('updated_at', staleBefore)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let kicked = 0
  for (const job of jobs ?? []) {
    // Auth expiry is not recoverable without the user signing in again.
    if (job.phase === 'Gmail access expired') continue

    const incomplete = hasIncompleteScan(job)

    if (!incomplete) continue

    const lock = job.chunk_locked_at ? new Date(job.chunk_locked_at).getTime() : 0
    const lockStale = !job.chunk_locked_at || lock < new Date(lockStaleBefore).getTime()
    if (!lockStale) continue

    scheduleScanContinuation(job.user_id)
    kicked++
  }

  return NextResponse.json({ ok: true, kicked })
}
