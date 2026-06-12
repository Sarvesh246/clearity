import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getRefreshToken } from '@/lib/gmail/getRefreshToken'
import { GmailNotConnectedError } from '@/lib/gmail/getRefreshTokenForUser'
import { getGmailClient } from '@/lib/gmail/client'
import { getMessageIdsForSenders } from '@/lib/gmail/getMessageIds'
import { trashMessages } from '@/lib/gmail/bulkActions'
import { unsubscribeSender } from '@/lib/gmail/unsubscribe'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import { acquireActionSlot, busyResponseBody } from '@/lib/scan/actionGuard'
import { chunk } from '@/lib/utils'
import type { UserSender } from '@/types'

// Unsubscribing + deleting across many senders can run for minutes â€” match
// the scan routes' budget.
export const maxDuration = 300

/** .in() values travel in the URL â€” keep each request comfortably small. */
const IN_CHUNK = 200

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let index = 0
  async function runNext(): Promise<void> {
    const current = index++
    if (current >= tasks.length) return
    results[current] = await tasks[current]()
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext))
  return results
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { senderEmails, deleteAfter = true }: { senderEmails: string[]; deleteAfter?: boolean } = await req.json()

  if (!senderEmails?.length) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const admin = adminClient()

  // Scans and bulk actions share the progress row and Gmail rate budget â€”
  // refuse to run while a scan is live instead of corrupting its state.
  const slot = await acquireActionSlot(admin, user.id)
  if (!slot.ok) {
    return NextResponse.json(busyResponseBody(slot.reason), { status: 409 })
  }

  const statuses: Record<string, 'queued' | 'in_progress' | 'done'> = {}
  for (const email of senderEmails) statuses[email] = 'queued'

  await admin.from('scan_jobs').upsert({
    user_id: user.id,
    status: 'scanning',
    action_type: 'unsub_delete',
    phase: 'Unsubscribing...',
    scanned: 0,
    total: 0,
    processed: 0,
    sender_statuses: statuses,
    unsubscribe_statuses: {},
    started_at: new Date().toISOString(),
    completed_at: null,
  })

  try {
    const refreshToken = await getRefreshToken()
    const gmail = getGmailClient(refreshToken)

    // Fetch full sender records for unsubscribe data (chunked â€” .in() is
    // URL-bound and a single select caps at 1000 rows)
    const senderMap = new Map<string, UserSender>()
    for (const emails of chunk(senderEmails, IN_CHUNK)) {
      const { data: senderRecords } = await admin
        .from('user_senders')
        .select('*')
        .eq('user_id', user.id)
        .in('sender_email', emails)
      for (const s of (senderRecords ?? [])) senderMap.set(s.sender_email, s as UserSender)
    }

    // â”€â”€ Phase 1: Unsubscribe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const unsubscribeResults: Record<string, { success: boolean; method: string; error?: string }> = {}

    const unsubTasks = senderEmails.map(email => async () => {
      statuses[email] = 'in_progress'
      await admin.from('scan_jobs').update({
        sender_statuses: statuses,
        phase: 'Unsubscribing...',
      }).eq('user_id', user.id)

      const sender = senderMap.get(email)
      if (!sender?.has_unsubscribe_header) {
        statuses[email] = 'done'
        unsubscribeResults[email] = { success: false, method: 'none' }
      } else {
        const result = await unsubscribeSender(gmail, sender)
        statuses[email] = 'done'
        unsubscribeResults[email] = { success: result.success, method: result.method, error: result.error }
      }

      await admin.from('scan_jobs').update({
        sender_statuses: statuses,
        unsubscribe_statuses: unsubscribeResults,
      }).eq('user_id', user.id)
    })

    await withConcurrencyLimit(unsubTasks, 5)

    let totalSucceeded = 0
    let totalFailed = 0

    // â”€â”€ Phase 2: Delete emails (skipped for Unsubscribe Only) â”€â”€â”€â”€
    if (deleteAfter) {
      for (const email of senderEmails) statuses[email] = 'queued'

      await admin.from('scan_jobs').update({
        phase: 'Deleting emails...',
        sender_statuses: statuses,
        unsubscribe_statuses: unsubscribeResults,
      }).eq('user_id', user.id)

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
        phase: 'Deleting emails...',
        sender_statuses: statuses,
      }).eq('user_id', user.id)

      let lastDbUpdate = 0

      for (const { email, ids } of perSender) {
        statuses[email] = 'in_progress'
        await admin.from('scan_jobs').update({
          sender_statuses: statuses,
          phase: `Deleting from ${email}...`,
        }).eq('user_id', user.id)

        if (ids.length === 0) {
          statuses[email] = 'done'
          await admin.from('scan_jobs').update({ sender_statuses: statuses }).eq('user_id', user.id)
          continue
        }

        const onProgress = async (processed: number) => {
          const globalProcessed = totalSucceeded + totalFailed + processed
          if (globalProcessed - lastDbUpdate >= 500 || processed >= ids.length) {
            lastDbUpdate = globalProcessed
            await admin.from('scan_jobs').update({ processed: globalProcessed }).eq('user_id', user.id)
          }
        }

        const result = await trashMessages(gmail, ids, onProgress)
        totalSucceeded += result.succeeded
        totalFailed += result.failed

        statuses[email] = 'done'
        await admin.from('scan_jobs').update({
          sender_statuses: statuses,
          processed: totalSucceeded + totalFailed,
        }).eq('user_id', user.id)
      }
    }

    // â”€â”€ Post-action DB updates (chunked â€” .in() is URL-bound) â”€â”€â”€â”€
    const successfullyUnsubscribed = senderEmails.filter(e => unsubscribeResults[e]?.success)
    for (const emails of chunk(successfullyUnsubscribed, IN_CHUNK)) {
      await admin.from('user_senders')
        .update({ is_unsubscribed: true })
        .eq('user_id', user.id)
        .in('sender_email', emails)
    }

    // Only zero email counts when emails were actually deleted
    if (deleteAfter) {
      for (const emails of chunk(senderEmails, IN_CHUNK)) {
        await admin.from('user_senders')
          .update({ email_count: 0, unread_count: 0 })
          .eq('user_id', user.id)
          .in('sender_email', emails)
      }
    }

    await admin.from('scan_jobs').update({
      status: 'complete',
      phase: 'Done',
      processed: totalSucceeded + totalFailed,
      completed_at: new Date().toISOString(),
    }).eq('user_id', user.id)

    return NextResponse.json({
      success: true,
      processed: totalSucceeded,
      failed: totalFailed,
      unsubscribed: successfullyUnsubscribed.length,
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
    const message = err instanceof Error ? err.message : 'Unsubscribe failed'
    await admin.from('scan_jobs').update({ status: 'error', phase: message }).eq('user_id', user.id)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    await slot.release()
  }
}
