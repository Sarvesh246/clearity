import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getRefreshToken } from '@/lib/gmail/getRefreshToken'
import { getGmailClient } from '@/lib/gmail/client'
import { scanInbox } from '@/lib/gmail/scanner'
import { classify } from '@/lib/classification/classify'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import { ScanCancelledError } from '@/types'

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

  // Initialize scan job
  await admin.from('scan_jobs').upsert({
    user_id: user.id,
    status: 'scanning',
    phase: 'Connecting to Gmail...',
    scanned: 0,
    total: 0,
    started_at: new Date().toISOString(),
    completed_at: null,
  })

  let cancelPoll: ReturnType<typeof setInterval> | undefined

  try {
    // Clear stale sender data — sender_classifications cache is intentionally preserved
    await admin.from('user_senders').delete().eq('user_id', user.id)

    const refreshToken = await getRefreshToken()
    const gmail = getGmailClient(refreshToken)

    const onProgress = async (scanned: number, total: number, phase: string) => {
      await admin.from('scan_jobs').update({ scanned, total, phase }).eq('user_id', user.id)
    }

    await onProgress(0, 0, 'Connecting to Gmail...')

    const ac = new AbortController()

    // Poll DB every 3s so the user can cancel from the client
    cancelPoll = setInterval(async () => {
      const { data } = await admin.from('scan_jobs').select('status').eq('user_id', user.id).single()
      if (data?.status === 'cancelled') { ac.abort(); clearInterval(cancelPoll) }
    }, 3000)

    const { senders, totalMessages } = await scanInbox(gmail, { onProgress, signal: ac.signal })
    clearInterval(cancelPoll)

    await onProgress(totalMessages, totalMessages, 'Saving results...')

    // Upsert senders in batches of 500
    const BATCH = 500
    const now = new Date().toISOString()
    for (let i = 0; i < senders.length; i += BATCH) {
      const batch = senders.slice(i, i + BATCH).map(s => ({
        user_id: user.id,
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
      await admin.from('user_senders').upsert(batch, {
        onConflict: 'user_id,sender_email',
      })
    }

    // Classify senders
    await onProgress(totalMessages, totalMessages, 'Classifying senders...')
    await classify(senders, user.id, admin)

    // Update last_scan_at on profile
    await admin.from('profiles').update({ last_scan_at: now }).eq('id', user.id)

    // Mark scan complete
    await admin.from('scan_jobs').update({
      status: 'complete',
      phase: 'Done',
      scanned: totalMessages,
      total: totalMessages,
      completed_at: now,
    }).eq('user_id', user.id)

    return NextResponse.json({ totalScanned: totalMessages, senderCount: senders.length })
  } catch (err) {
    clearInterval(cancelPoll)
    if (err instanceof ScanCancelledError) {
      await admin.from('scan_jobs').update({
        status: 'cancelled',
        phase: 'Scan cancelled',
        completed_at: new Date().toISOString(),
      }).eq('user_id', user.id)
      return NextResponse.json({ cancelled: true })
    }
    if (isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', user.id)
      await admin.from('scan_jobs').update({ status: 'error', phase: 'Gmail access expired' }).eq('user_id', user.id)
      return NextResponse.json(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired — sign in again to continue' },
        { status: 401 }
      )
    }
    const message = err instanceof Error ? err.message : 'Scan failed'
    await admin.from('scan_jobs').update({ status: 'error', phase: message }).eq('user_id', user.id)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
