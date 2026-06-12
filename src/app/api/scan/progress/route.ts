import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { ScanProgress } from '@/types'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data } = await supabase
    .from('scan_jobs')
    .select('status, phase, scanned, total, action_type, processed, sender_statuses')
    .eq('user_id', user.id)
    .single()

  if (!data) {
    const idle: ScanProgress = { status: 'idle', phase: '', scanned: 0, total: 0 }
    return NextResponse.json(idle)
  }

  const progress: ScanProgress = {
    status: data.status as ScanProgress['status'],
    phase: data.phase ?? '',
    scanned: data.scanned ?? 0,
    total: data.total ?? 0,
    action_type: data.action_type ?? null,
    processed: data.processed ?? 0,
    sender_statuses: data.sender_statuses ?? {},
  }

  return NextResponse.json(progress)
}
