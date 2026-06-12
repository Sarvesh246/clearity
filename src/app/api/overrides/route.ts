import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import type { Classification } from '@/types'

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { senderEmail, override }: { senderEmail: string; override: Classification | null } = await req.json()
  if (!senderEmail) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const admin = adminClient()
  if (override === null) {
    await admin.from('user_sender_overrides').delete()
      .eq('user_id', user.id).eq('sender_email', senderEmail)
  } else {
    await admin.from('user_sender_overrides').upsert(
      { user_id: user.id, sender_email: senderEmail, override },
      { onConflict: 'user_id,sender_email' }
    )
  }
  return NextResponse.json({ ok: true })
}
