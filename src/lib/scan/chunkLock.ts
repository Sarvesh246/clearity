import type { SupabaseClient } from '@supabase/supabase-js'

const LOCK_STALE_MS = 6 * 60 * 1000

export async function tryAcquireChunkLock(
  admin: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data: job } = await admin
    .from('scan_jobs')
    .select('status, chunk_locked_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (!job || job.status !== 'scanning') return false

  if (job.chunk_locked_at) {
    const lockedAt = new Date(job.chunk_locked_at).getTime()
    if (Date.now() - lockedAt < LOCK_STALE_MS) return false
  }

  const now = new Date().toISOString()
  const { data: updated } = await admin
    .from('scan_jobs')
    .update({ chunk_locked_at: now, updated_at: now })
    .eq('user_id', userId)
    .eq('status', 'scanning')
    .select('user_id')
    .maybeSingle()

  return !!updated
}

export async function releaseChunkLock(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  await admin
    .from('scan_jobs')
    .update({
      chunk_locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
}
