import type { SupabaseClient } from '@supabase/supabase-js'
import type { SenderData } from '@/lib/gmail/scanner'

export async function upsertSendersList(
  admin: SupabaseClient,
  userId: string,
  senders: SenderData[]
): Promise<void> {
  if (senders.length === 0) return

  const now = new Date().toISOString()
  const BATCH = 500

  for (let i = 0; i < senders.length; i += BATCH) {
    const batch = senders.slice(i, i + BATCH).map(s => ({
      user_id: userId,
      sender_email: s.sender_email,
      sender_name: s.sender_name,
      domain: s.domain,
      email_count: s.email_count,
      unread_count: s.unread_count,
      has_unsubscribe_header: s.has_unsubscribe_header,
      unsubscribe_mailto: s.unsubscribe_mailto,
      unsubscribe_url: s.unsubscribe_url,
      unsubscribe_post: s.unsubscribe_post,
      gmail_labels: s.gmail_labels,
      last_scanned_at: now,
    }))

    const { error } = await admin.from('user_senders').upsert(batch, {
      onConflict: 'user_id,sender_email',
    })
    if (error) throw error
  }
}

export async function upsertSendersFromMap(
  admin: SupabaseClient,
  userId: string,
  senderMap: Map<string, SenderData>
): Promise<void> {
  await upsertSendersList(admin, userId, Array.from(senderMap.values()))
}

export async function loadSendersIntoMap(
  admin: SupabaseClient,
  userId: string
): Promise<Map<string, SenderData>> {
  const map = new Map<string, SenderData>()
  const PAGE = 1000
  let from = 0

  while (true) {
    const { data } = await admin
      .from('user_senders')
      .select(
        'sender_email,sender_name,domain,email_count,unread_count,has_unsubscribe_header,unsubscribe_mailto,unsubscribe_url,unsubscribe_post,gmail_labels'
      )
      .eq('user_id', userId)
      .range(from, from + PAGE - 1)

    if (!data?.length) break

    for (const row of data) {
      map.set(row.sender_email, {
        sender_email: row.sender_email,
        sender_name: row.sender_name,
        domain: row.domain,
        email_count: row.email_count,
        unread_count: row.unread_count,
        has_unsubscribe_header: row.has_unsubscribe_header,
        unsubscribe_mailto: row.unsubscribe_mailto,
        unsubscribe_url: row.unsubscribe_url,
        unsubscribe_post: row.unsubscribe_post ?? false,
        gmail_labels: row.gmail_labels ?? [],
      })
    }

    if (data.length < PAGE) break
    from += PAGE
  }

  return map
}
