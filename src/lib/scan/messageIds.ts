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
