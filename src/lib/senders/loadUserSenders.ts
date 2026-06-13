import { fetchAllRows } from '@/lib/supabase/fetchAllRows'
import type { Classification, UserSender } from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Paginate by stable primary key, then sort for display. */
export async function loadUserSenders(
  supabase: SupabaseClient,
  userId: string
): Promise<UserSender[]> {
  const [allSenders, allOverrides] = await Promise.all([
    fetchAllRows<UserSender>((from, to) =>
      supabase
        .from('user_senders')
        .select('*')
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(from, to)
    ),
    fetchAllRows<{ sender_email: string; override: string }>((from, to) =>
      supabase
        .from('user_sender_overrides')
        .select('sender_email, override')
        .eq('user_id', userId)
        .order('sender_email', { ascending: true })
        .range(from, to)
    ),
  ])

  const overrideMap = new Map(
    allOverrides.map(o => [o.sender_email, o.override as Classification])
  )

  return allSenders
    .map(s => ({
      ...s,
      classification: (overrideMap.get(s.sender_email) ?? s.classification) as Classification | null,
    }))
    .sort(
      (a, b) =>
        b.email_count - a.email_count ||
        a.sender_email.localeCompare(b.sender_email)
    )
}
