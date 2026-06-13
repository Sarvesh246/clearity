import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadUserSenders } from '@/lib/senders/loadUserSenders'

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const senders = await loadUserSenders(supabase, user.id)
    return NextResponse.json({ senders }, { headers: NO_CACHE })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load senders'
    return NextResponse.json({ error: message }, { status: 500, headers: NO_CACHE })
  }
}
