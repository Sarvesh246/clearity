import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getRefreshToken } from '@/lib/gmail/getRefreshToken'
import { GmailNotConnectedError } from '@/lib/gmail/getRefreshTokenForUser'
import { getGmailClient } from '@/lib/gmail/client'
import { processSendersInterleaved } from '@/lib/gmail/processSenders'
import { trashMessages, markAsRead, archiveMessages } from '@/lib/gmail/bulkActions'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import { acquireActionSlot, busyResponseBody } from '@/lib/scan/actionGuard'
import { chunk } from '@/lib/utils'

// Bulk actions over tens of thousands of emails far exceed the default
// function duration â€” match the scan routes' budget.
export const maxDuration = 300

/** Stop picking up new senders this far in, leaving headroom under maxDuration
 * for the final DB writes so a huge selection finalizes partial work instead of
 * being hard-killed with the job row stuck 'scanning'. */
const ACTION_TIME_BUDGET_MS = 240_000

/** .in() values travel in the URL â€” keep each request comfortably small. */
const IN_CHUNK = 200

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

  // Scans and bulk actions share the progress row and Gmail rate budget â€”
  // refuse to run while a scan is live instead of corrupting its state.
  const slot = await acquireActionSlot(admin, user.id)
  if (!slot.ok) {
    return NextResponse.json(busyResponseBody(slot.reason), { status: 409 })
  }

  // In-memory status map â€” written to DB as a whole JSONB blob
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

    // Estimate the email total up front (sum of known counts) so the progress
    // bar has a denominator immediately instead of sitting on "Collecting
    // message IDs..." while we work through thousands of senders.
    let estimatedTotal = 0
    for (const emails of chunk(senderEmails, IN_CHUNK)) {
      const { data } = await admin
        .from('user_senders')
        .select('email_count')
        .eq('user_id', user.id)
        .in('sender_email', emails)
      for (const row of (data ?? [])) estimatedTotal += row.email_count ?? 0
    }

    await admin.from('scan_jobs').update({
      total: estimatedTotal,
      phase: 'Processing emails...',
    }).eq('user_id', user.id)

    const actionFn =
      action === 'trash' ? trashMessages : action === 'mark_read' ? markAsRead : archiveMessages

    const { processedSenders, totalSucceeded, totalFailed, timedOut } =
      await processSendersInterleaved(gmail, senderEmails, {
        deadline: Date.now() + ACTION_TIME_BUDGET_MS,
        action: actionFn,
        onSenderStart: async email => {
          statuses[email] = 'in_progress'
          await admin.from('scan_jobs').update({
            sender_statuses: statuses,
            phase: `Processing ${email}...`,
          }).eq('user_id', user.id)
        },
        onSenderDone: async (email, globalProcessed) => {
          statuses[email] = 'done'
          await admin.from('scan_jobs').update({
            sender_statuses: statuses,
            processed: globalProcessed,
          }).eq('user_id', user.id)
        },
        onProgress: async globalProcessed => {
          await admin.from('scan_jobs').update({ processed: globalProcessed }).eq('user_id', user.id)
        },
      })

    // Only update counts for senders we actually finished (a timed-out run
    // leaves the rest untouched so the user can re-run on them).
    if (action === 'trash') {
      for (const emails of chunk(processedSenders, IN_CHUNK)) {
        await admin.from('user_senders')
          .update({ email_count: 0, unread_count: 0 })
          .eq('user_id', user.id)
          .in('sender_email', emails)
      }
    } else if (action === 'mark_read') {
      for (const emails of chunk(processedSenders, IN_CHUNK)) {
        await admin.from('user_senders')
          .update({ unread_count: 0 })
          .eq('user_id', user.id)
          .in('sender_email', emails)
      }
    }

    await admin.from('scan_jobs').update({
      status: 'complete',
      phase: timedOut ? 'Stopped early — run again to finish the rest' : 'Done',
      processed: totalSucceeded + totalFailed,
      completed_at: new Date().toISOString(),
    }).eq('user_id', user.id)

    return NextResponse.json({
      success: true,
      processed: totalSucceeded,
      failed: totalFailed,
      partial: timedOut,
    })
  } catch (err) {
    if (err instanceof GmailNotConnectedError || isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', user.id)
      await admin.from('scan_jobs').update({ status: 'error', phase: 'Gmail access expired' }).eq('user_id', user.id)
      return NextResponse.json(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired â€” sign in again to continue' },
        { status: 401 }
      )
    }
    const message = err instanceof Error ? err.message : 'Action failed'
    await admin.from('scan_jobs').update({ status: 'error', phase: message }).eq('user_id', user.id)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    await slot.release()
  }
}
