import type { SupabaseClient } from '@supabase/supabase-js'

/** A held lock older than this is considered stale (worker died) and reclaimable. */
const LOCK_STALE_MS = 6 * 60 * 1000

/**
 * Acquire the per-user scan lock atomically.
 *
 * The lock guarantees only one scan chunk processes a user's inbox at a time —
 * critical because concurrent chunks would double Gmail's request rate and trip
 * the 250-units/sec per-user limit (429s).
 *
 * Correctness relies on a single compare-and-swap UPDATE whose WHERE clause
 * includes the lock column itself. Postgres serializes concurrent UPDATEs on the
 * same row, so a second caller re-evaluates the predicate against the row the
 * winner just wrote and matches zero rows. (The previous check-then-update split
 * let two callers both "see" a free lock and both acquire it.)
 *
 * Unlike before, this does NOT require status === 'scanning', so a fresh
 * user-initiated scan (after complete/cancelled/idle, or a brand-new user with no
 * row) can acquire the lock and start. runScanChunk decides what work to do.
 */
export async function tryAcquireChunkLock(
  admin: SupabaseClient,
  userId: string
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const staleIso = new Date(Date.now() - LOCK_STALE_MS).toISOString()

  // Ensure a row exists without clobbering an in-progress one.
  await admin
    .from('scan_jobs')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })

  // Atomic CAS: grab the lock only if it's currently free or stale.
  const { data } = await admin
    .from('scan_jobs')
    .update({ chunk_locked_at: nowIso, updated_at: nowIso })
    .eq('user_id', userId)
    .or(`chunk_locked_at.is.null,chunk_locked_at.lt."${staleIso}"`)
    .select('user_id')
    .maybeSingle()

  return !!data
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
