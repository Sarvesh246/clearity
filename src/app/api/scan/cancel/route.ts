import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { finalizePartialScan } from '@/lib/scan/classifyPartial'

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = adminClient()
  const now = new Date().toISOString()

  const partial = await finalizePartialScan(admin, user.id)

  await admin
    .from('scan_jobs')
    .update({
      status: 'cancelled',
      phase: partial.senderCount > 0
        ? `Stopped — ${partial.senderCount.toLocaleString()} senders saved and ready to review`
        : 'Scan cancelled',
      completed_at: now,
      list_page_token: null,
      list_complete: true,
    })
    .eq('user_id', user.id)

  return NextResponse.json({ ok: true, ...partial })
}
