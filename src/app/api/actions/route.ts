import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getRefreshToken } from '@/lib/gmail/getRefreshToken'
import { getGmailClient } from '@/lib/gmail/client'
import { getMessageIdsForSenders } from '@/lib/gmail/getMessageIds'
import { trashMessages, markAsRead, archiveMessages } from '@/lib/gmail/bulkActions'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface ActionRequest {
  action: 'trash' | 'mark_read' | 'archive'
  senderEmails: string[]
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body: ActionRequest = await req.json()
  const { action, senderEmails } = body

  if (!action || !senderEmails?.length) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const admin = adminClient()

  // In-memory status map — written to DB as a whole JSONB blob
  const statuses: Record<string, 'queued' | 'in_progress' | 'done'> = {}
  for (const email of senderEmails) statuses[email] = 'queued'

  await admin.from('scan_jobs').upsert({
    user_id: user.id,
    status: 'scanning',
    action_type: action,
    phase: 'Collecting message IDs...',
    scanned: 0,
    total: 0,
    processed: 0,
    sender_statuses: statuses,
    started_at: new Date().toISOString(),
    completed_at: null,
  })

  try {
    const refreshToken = await getRefreshToken()
    const gmail = getGmailClient(refreshToken)

    const onSenderStart = async (email: string) => {
      statuses[email] = 'in_progress'
      await admin.from('scan_jobs').update({
        sender_statuses: statuses,
        phase: `Collecting IDs from ${email}...`,
      }).eq('user_id', user.id)
    }

    const { allIds, perSender } = await getMessageIdsForSenders(gmail, senderEmails, onSenderStart)

    await admin.from('scan_jobs').update({
      total: allIds.length,
      phase: 'Processing emails...',
      sender_statuses: statuses,
    }).eq('user_id', user.id)

    let totalSucceeded = 0
    let totalFailed = 0
    let lastDbUpdate = 0

    for (const { email, ids } of perSender) {
      statuses[email] = 'in_progress'
      await admin.from('scan_jobs').update({
        sender_statuses: statuses,
        phase: `Processing ${email}...`,
      }).eq('user_id', user.id)

      if (ids.length === 0) {
        statuses[email] = 'done'
        await admin.from('scan_jobs').update({ sender_statuses: statuses }).eq('user_id', user.id)
        continue
      }

      const onProgress = async (processed: number, _total: number) => {
        const globalProcessed = totalSucceeded + totalFailed + processed
        if (globalProcessed - lastDbUpdate >= 500 || processed >= ids.length) {
          lastDbUpdate = globalProcessed
          await admin.from('scan_jobs').update({ processed: globalProcessed }).eq('user_id', user.id)
        }
      }

      let result: { succeeded: number; failed: number }
      if (action === 'trash') {
        result = await trashMessages(gmail, ids, onProgress)
      } else if (action === 'mark_read') {
        result = await markAsRead(gmail, ids, onProgress)
      } else {
        result = await archiveMessages(gmail, ids, onProgress)
      }

      totalSucceeded += result.succeeded
      totalFailed += result.failed

      statuses[email] = 'done'
      await admin.from('scan_jobs').update({
        sender_statuses: statuses,
        processed: totalSucceeded + totalFailed,
      }).eq('user_id', user.id)
    }

    // Post-action: update user_senders counts
    if (action === 'trash') {
      await admin.from('user_senders')
        .update({ email_count: 0, unread_count: 0 })
        .eq('user_id', user.id)
        .in('sender_email', senderEmails)
    } else if (action === 'mark_read') {
      await admin.from('user_senders')
        .update({ unread_count: 0 })
        .eq('user_id', user.id)
        .in('sender_email', senderEmails)
    }

    await admin.from('scan_jobs').update({
      status: 'complete',
      phase: 'Done',
      processed: totalSucceeded + totalFailed,
      completed_at: new Date().toISOString(),
    }).eq('user_id', user.id)

    return NextResponse.json({ success: true, processed: totalSucceeded, failed: totalFailed })
  } catch (err) {
    if (isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', user.id)
      await admin.from('scan_jobs').update({ status: 'error', phase: 'Gmail access expired' }).eq('user_id', user.id)
      return NextResponse.json(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired — sign in again to continue' },
        { status: 401 }
      )
    }
    const message = err instanceof Error ? err.message : 'Action failed'
    await admin.from('scan_jobs').update({ status: 'error', phase: message }).eq('user_id', user.id)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
