import type { SupabaseClient } from '@supabase/supabase-js'
import { tryAcquireChunkLock, releaseChunkLock } from './chunkLock'

/**
 * A scan whose progress row was updated within this window is considered live.
 * Older ones are treated as dead (worker chain lost) so the user isn't locked
 * out of bulk actions forever; the cron can still revive the scan afterwards.
 */
const SCAN_ACTIVE_WINDOW_MS = 10 * 60 * 1000
/** Re-stamp the lock well inside chunkLock's 6-minute staleness threshold. */
const LOCK_HEARTBEAT_MS = 60 * 1000

export type ActionSlot =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: 'scan_running' | 'busy' }

/**
 * Bulk actions and scans share the per-user scan_jobs progress row AND the
 * Gmail per-user rate budget, so they must never run concurrently. A bulk
 * action starting mid-scan would overwrite the scan's status/progress fields,
 * orphan the background continuation chain, and have its count updates undone
 * by the scan's next sender upsert.
 *
 * This acquires the same chunk lock the scan workers use (making scan chunks
 * skip while an action runs) and refreshes it on a heartbeat so actions longer
 * than the lock's staleness window aren't stolen from.
 */
export async function acquireActionSlot(
  admin: SupabaseClient,
  userId: string
): Promise<ActionSlot> {
  const { data: job } = await admin
    .from('scan_jobs')
    .select('status, action_type, updated_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (
    job?.status === 'scanning' &&
    !job.action_type &&
    job.updated_at &&
    Date.now() - new Date(job.updated_at).getTime() < SCAN_ACTIVE_WINDOW_MS
  ) {
    return { ok: false, reason: 'scan_running' }
  }

  const acquired = await tryAcquireChunkLock(admin, userId)
  if (!acquired) return { ok: false, reason: 'busy' }

  const heartbeat = setInterval(() => {
    admin
      .from('scan_jobs')
      .update({ chunk_locked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .then(
        () => {},
        () => {}
      )
  }, LOCK_HEARTBEAT_MS)

  return {
    ok: true,
    release: async () => {
      clearInterval(heartbeat)
      await releaseChunkLock(admin, userId)
    },
  }
}

export function busyResponseBody(reason: 'scan_running' | 'busy') {
  return reason === 'scan_running'
    ? {
        error: 'scan_running',
        message: 'An inbox scan is running — wait for it to finish or cancel it first.',
      }
    : {
        error: 'busy',
        message: 'Another operation is already running — try again in a moment.',
      }
}
