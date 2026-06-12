import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

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

  const now = new Date().toISOString()
  await adminClient()
    .from('scan_jobs')
    .update({
      status: 'cancelled',
      phase: 'Scan paused — tap Continue Scan to resume',
      cancelled_at: now,
      completed_at: now,
    })
    .eq('user_id', user.id)

  return NextResponse.json({ ok: true })
}
