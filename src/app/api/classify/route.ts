import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { classify } from '@/lib/classification/classify'
import { SenderData } from '@/lib/gmail/scanner'

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = adminClient()

  const { data: rows, error } = await admin
    .from('user_senders')
    .select('sender_email,sender_name,domain,email_count,unread_count,has_unsubscribe_header,unsubscribe_mailto,unsubscribe_url,unsubscribe_post,gmail_labels')
    .eq('user_id', user.id)
    .is('classification', null)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const senders: SenderData[] = (rows ?? []).map(r => ({
    sender_email: r.sender_email,
    sender_name: r.sender_name,
    domain: r.domain,
    email_count: r.email_count,
    unread_count: r.unread_count,
    has_unsubscribe_header: r.has_unsubscribe_header,
    unsubscribe_mailto: r.unsubscribe_mailto,
    unsubscribe_url: r.unsubscribe_url,
    unsubscribe_post: r.unsubscribe_post,
    gmail_labels: r.gmail_labels ?? [],
  }))

  await classify(senders, user.id, admin)

  return NextResponse.json({ classified: senders.length })
}
