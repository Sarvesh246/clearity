import type { SupabaseClient } from '@supabase/supabase-js'

const INSERT_BATCH = 1000
const READ_BATCH = 500

export async function clearMessageIds(admin: SupabaseClient, userId: string): Promise<void> {
  await admin.from('scan_message_ids').delete().eq('user_id', userId)
}

export async function countMessageIds(admin: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await admin
    .from('scan_message_ids')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw error
  return count ?? 0
}

export async function insertMessageIds(
  admin: SupabaseClient,
  userId: string,
  startIdx: number,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return

  for (let i = 0; i < ids.length; i += INSERT_BATCH) {
    const slice = ids.slice(i, i + INSERT_BATCH)
    const rows = slice.map((message_id, offset) => ({
      user_id: userId,
      idx: startIdx + i + offset,
      message_id,
    }))
    const { error } = await admin.from('scan_message_ids').insert(rows)
    if (error) throw error
  }
}

/**
 * Drop IDs that are already stored for this user. Needed when resuming the
 * listing phase from a persisted page token: a previous invocation may have
 * crashed after inserting IDs but before saving its next page token, so the
 * re-listed pages overlap rows already inserted. Without this filter those
 * messages would be stored (and later scanned/counted) twice.
 */
export async function filterToNewMessageIds(
  admin: SupabaseClient,
  userId: string,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return ids

  const existing = new Set<string>()
  const CHECK_BATCH = 500
  for (let i = 0; i < ids.length; i += CHECK_BATCH) {
    const slice = ids.slice(i, i + CHECK_BATCH)
    const { data, error } = await admin
      .from('scan_message_ids')
      .select('message_id')
      .eq('user_id', userId)
      .in('message_id', slice)
    if (error) throw error
    for (const row of data ?? []) existing.add(row.message_id)
  }

  if (existing.size === 0) return ids
  return ids.filter(id => !existing.has(id))
}

export async function loadMessageIdSlice(
  admin: SupabaseClient,
  userId: string,
  fromIdx: number,
  limit: number
): Promise<string[]> {
  const { data, error } = await admin
    .from('scan_message_ids')
    .select('message_id')
    .eq('user_id', userId)
    .gte('idx', fromIdx)
    .lt('idx', fromIdx + limit)
    .order('idx', { ascending: true })

  if (error) throw error
  return (data ?? []).map(r => r.message_id)
}

/** Load IDs for one scan chunk without pulling the entire 200k list into memory. */
export async function loadMessageIdsForRange(
  admin: SupabaseClient,
  userId: string,
  fromIdx: number,
  toIdx: number
): Promise<string[]> {
  const ids: string[] = []
  for (let start = fromIdx; start < toIdx; start += READ_BATCH) {
    const slice = await loadMessageIdSlice(admin, userId, start, Math.min(READ_BATCH, toIdx - start))
    ids.push(...slice)
  }
  return ids
}
