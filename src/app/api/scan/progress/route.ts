import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ScanProgress } from '@/types'

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data } = await supabase
    .from('scan_jobs')
    .select('status, phase, scanned, total, cursor, list_complete, updated_at, action_type, processed, sender_statuses, unsubscribe_statuses')
    .eq('user_id', user.id)
    .single()

  if (!data) {
    const idle: ScanProgress = { status: 'idle', phase: '', scanned: 0, total: 0 }
    return NextResponse.json(idle, { headers: NO_CACHE })
  }

  const progress: ScanProgress = {
    status: data.status as ScanProgress['status'],
    phase: data.phase ?? '',
    scanned: data.scanned ?? 0,
    total: data.total ?? 0,
    cursor: data.cursor ?? undefined,
    list_complete: data.list_complete ?? undefined,
    updated_at: data.updated_at ?? null,
    action_type: data.action_type ?? null,
    processed: data.processed ?? 0,
    sender_statuses: data.sender_statuses ?? {},
    unsubscribe_statuses: data.unsubscribe_statuses ?? {},
  }

  return NextResponse.json(progress, { headers: NO_CACHE })
}
