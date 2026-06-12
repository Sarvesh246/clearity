import type { SupabaseClient } from '@supabase/supabase-js'
import { classify } from '@/lib/classification/classify'
import type { SenderData } from '@/lib/gmail/scanner'

function rowToSenderData(row: {
  sender_email: string
  sender_name: string | null
  domain: string
  email_count: number
  unread_count: number
  has_unsubscribe_header: boolean
  unsubscribe_mailto: string | null
  unsubscribe_url: string | null
  unsubscribe_post: boolean | null
  gmail_labels: string[] | null
}): SenderData {
  return {
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
  }
}

/** Classify senders that don't have a classification yet (paginated). */
export async function classifyUnclassifiedSenders(
  admin: SupabaseClient,
  userId: string
): Promise<number> {
  const PAGE = 500
  let from = 0
  let total = 0

  while (true) {
    const { data: rows, error } = await admin
      .from('user_senders')
      .select(
        'sender_email,sender_name,domain,email_count,unread_count,has_unsubscribe_header,unsubscribe_mailto,unsubscribe_url,unsubscribe_post,gmail_labels'
      )
      .eq('user_id', userId)
      .is('classification', null)
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (!rows?.length) break

    await classify(rows.map(rowToSenderData), userId, admin)
    total += rows.length

    if (rows.length < PAGE) break
    from += PAGE
  }

  return total
}

/** After a partial scan ends, classify remaining senders and stamp last_scan_at. */
export async function finalizePartialScan(
  admin: SupabaseClient,
  userId: string
): Promise<{ senderCount: number; emailCount: number }> {
  await classifyUnclassifiedSenders(admin, userId)

  const { data: senders } = await admin
    .from('user_senders')
    .select('email_count')
    .eq('user_id', userId)

  const rows = senders ?? []
  const emailCount = rows.reduce((n, s) => n + (s.email_count ?? 0), 0)

  if (rows.length > 0) {
    await admin.from('profiles').update({
      last_scan_at: new Date().toISOString(),
    }).eq('id', userId)
  }

  return { senderCount: rows.length, emailCount }
}
