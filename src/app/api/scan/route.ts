import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getRefreshToken } from '@/lib/gmail/getRefreshToken'
import { getGmailClient } from '@/lib/gmail/client'
import { listMessageIdsChunk } from '@/lib/gmail/listMessages'
import { CHUNK_TIME_BUDGET_MS, scanMessageIds } from '@/lib/gmail/scanner'
import { incrementalSync } from '@/lib/gmail/incrementalScan'
import { classify } from '@/lib/classification/classify'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import {
  clearMessageIds,
  countMessageIds,
  insertMessageIds,
  loadMessageIdsForRange,
} from '@/lib/scan/messageIds'
import {
  loadSendersIntoMap,
  upsertSendersList,
} from '@/lib/scan/persistence'
import { ScanCancelledError } from '@/types'

export const maxDuration = 300

/** IDs loaded per scan invocation — avoids loading 200k into memory. */
const ID_SLICE = 4000

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface ScanJobRow {
  status: string
  phase: string | null
  scanned: number | null
  total: number | null
  cursor: number | null
  list_page_token: string | null
  list_complete: boolean | null
}

async function finalizeScan(
  admin: ReturnType<typeof adminClient>,
  userId: string,
  historyId: string | null
) {
  const now = new Date().toISOString()
  const senderMap = await loadSendersIntoMap(admin, userId)
  const senders = Array.from(senderMap.values())

  await admin.from('scan_jobs').update({
    phase: 'Classifying senders...',
    scanned: senders.reduce((n, s) => n + s.email_count, 0),
  }).eq('user_id', userId)

  await classify(senders, userId, admin)

  const totalMessages = senders.reduce((n, s) => n + s.email_count, 0)

  await admin.from('profiles').update({
    last_scan_at: now,
    ...(historyId ? { gmail_history_id: historyId } : {}),
  }).eq('id', userId)

  await clearMessageIds(admin, userId)

  await admin.from('scan_jobs').update({
    status: 'complete',
    phase: 'Done',
    scanned: totalMessages,
    total: totalMessages,
    completed_at: now,
    cursor: 0,
    list_page_token: null,
    list_complete: true,
  }).eq('user_id', userId)

  return { totalMessages, senderCount: senders.length }
}

async function saveScanProgress(
  admin: ReturnType<typeof adminClient>,
  userId: string,
  fields: Record<string, unknown>
) {
  await admin.from('scan_jobs').update(fields).eq('user_id', userId)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const forceFull = body.full === true
  const resumeRequested = body.resume === true
  const runStartedAt = new Date().toISOString()

  const admin = adminClient()

  const [{ data: job }, { data: profile }] = await Promise.all([
    admin.from('scan_jobs').select('*').eq('user_id', user.id).maybeSingle(),
    admin.from('profiles').select('last_scan_at, gmail_history_id').eq('id', user.id).single(),
  ])

  const existingJob = job as ScanJobRow | null
  const total = existingJob?.total ?? 0
  const cursor = existingJob?.cursor ?? 0
  const listComplete = existingJob?.list_complete ?? false

  const hasIncompleteScan =
    existingJob &&
    (!listComplete || cursor < total) &&
    (total > 0 || existingJob.list_page_token)

  const canResume =
    !forceFull &&
    (resumeRequested || existingJob?.status === 'scanning' || existingJob?.status === 'error') &&
    hasIncompleteScan

  const useIncremental =
    !forceFull &&
    !canResume &&
    !!profile?.last_scan_at &&
    !!profile?.gmail_history_id

  let cancelPoll: ReturnType<typeof setInterval> | undefined
  let globalCursor = cursor

  try {
    if (useIncremental) {
      await admin.from('scan_jobs').upsert({
        user_id: user.id,
        status: 'scanning',
        phase: 'Syncing new emails...',
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
      })
    } else if (canResume) {
      await saveScanProgress(admin, user.id, {
        status: 'scanning',
        phase: listComplete ? 'Resuming scan...' : 'Resuming email list...',
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
      })
    } else {
      await clearMessageIds(admin, user.id)
      await admin.from('user_senders').delete().eq('user_id', user.id)
      await admin.from('scan_jobs').upsert({
        user_id: user.id,
        status: 'scanning',
        phase: 'Connecting to Gmail...',
        scanned: 0,
        total: 0,
        cursor: 0,
        list_page_token: null,
        list_complete: false,
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
      })
    }

    const refreshToken = await getRefreshToken()
    const gmail = getGmailClient(refreshToken)
    const deadline = Date.now() + CHUNK_TIME_BUDGET_MS

    const ac = new AbortController()
    cancelPoll = setInterval(async () => {
      const { data } = await admin
        .from('scan_jobs')
        .select('status, started_at, cancelled_at')
        .eq('user_id', user.id)
        .single()
      if (data?.status !== 'cancelled') return
      const cancelledAt = data.cancelled_at ? new Date(data.cancelled_at).getTime() : 0
      const startedAt = data.started_at ? new Date(data.started_at).getTime() : 0
      // Only abort if cancel happened after this run started (ignore stale cancels)
      if (cancelledAt > startedAt) {
        ac.abort()
        clearInterval(cancelPoll)
      }
    }, 3000)

    const onProgress = async (scanned: number, totalCount: number, phase: string) => {
      await saveScanProgress(admin, user.id, { scanned, total: totalCount, phase })
    }

    // ── Incremental sync ─────────────────────────────────────────────────────
    if (useIncremental) {
      const existingMap = await loadSendersIntoMap(admin, user.id)

      let result
      try {
        result = await incrementalSync(
          gmail,
          profile!.gmail_history_id!,
          existingMap,
          {
            onProgress: async phase => onProgress(0, 0, phase),
            signal: ac.signal,
          }
        )
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status !== 404) throw err
        await admin.from('profiles').update({ gmail_history_id: null }).eq('id', user.id)
      }

      if (result) {
        clearInterval(cancelPoll)

        if (result.newMessageCount === 0) {
          await admin.from('profiles').update({
            last_scan_at: new Date().toISOString(),
            gmail_history_id: result.historyId,
          }).eq('id', user.id)

          await saveScanProgress(admin, user.id, {
            status: 'complete',
            phase: 'Already up to date',
            scanned: result.senders.reduce((n, s) => n + s.email_count, 0),
            total: result.senders.reduce((n, s) => n + s.email_count, 0),
            completed_at: new Date().toISOString(),
          })

          return NextResponse.json({ totalScanned: 0, senderCount: result.senders.length, incremental: true })
        }

        await upsertSendersList(admin, user.id, result.senders)
        const stats = await finalizeScan(admin, user.id, result.historyId)
        return NextResponse.json({ ...stats, incremental: true })
      }
    }

    // ── Phase 1: Resumable message ID listing ────────────────────────────────
    const { data: jobState } = await admin
      .from('scan_jobs')
      .select('list_complete, list_page_token, total, cursor')
      .eq('user_id', user.id)
      .single()

    let listingDone = jobState?.list_complete ?? false
    let messageTotal = jobState?.total ?? 0
    globalCursor = jobState?.cursor ?? 0
    let listPageToken: string | null = jobState?.list_page_token ?? null

    if (!listingDone) {
      while (Date.now() < deadline) {
        const existingCount = await countMessageIds(admin, user.id)

        const chunk = await listMessageIdsChunk(gmail, {
          pageToken: listPageToken,
          deadline,
          signal: ac.signal,
          onProgress: async foundInChunk => {
            const found = existingCount + foundInChunk
            // scanned stays 0 during listing — only metadata-read progress counts
            await onProgress(
              0,
              found,
              `Fetching email list… ${found.toLocaleString()} found`
            )
          },
        })

        if (chunk.ids.length > 0) {
          await insertMessageIds(admin, user.id, existingCount, chunk.ids)
        }

        messageTotal = await countMessageIds(admin, user.id)
        listingDone = chunk.listComplete
        listPageToken = chunk.nextPageToken

        await saveScanProgress(admin, user.id, {
          list_page_token: listPageToken,
          list_complete: listingDone,
          total: messageTotal,
          scanned: globalCursor,
          phase: listingDone
            ? `Found ${messageTotal.toLocaleString()} emails — scanning...`
            : `Fetching email list… ${messageTotal.toLocaleString()} found`,
        })

        if (listingDone || Date.now() >= deadline) break
      }

      if (!listingDone) {
        clearInterval(cancelPoll)
        return NextResponse.json({
          continued: true,
          phase: 'listing',
          total: messageTotal,
          scanned: globalCursor,
        })
      }
    } else {
      messageTotal = jobState?.total ?? await countMessageIds(admin, user.id)
    }

    // ── Phase 2: Resumable metadata scan ─────────────────────────────────────
    if (messageTotal === 0) {
      clearInterval(cancelPoll)
      const stats = await finalizeScan(admin, user.id, (await gmail.users.getProfile({ userId: 'me' })).data.historyId ?? null)
      return NextResponse.json({ ...stats, continued: false })
    }

    const senderMap = await loadSendersIntoMap(admin, user.id)
    const ids = await loadMessageIdsForRange(admin, user.id, globalCursor, globalCursor + ID_SLICE)

    if (ids.length === 0 && globalCursor < messageTotal) {
      throw new Error('Scan state mismatch — retry to continue')
    }

    const startedAt = Date.now()
    const { cursor: sliceCursor, chunkSenders } = await scanMessageIds(gmail, ids, senderMap, {
      signal: ac.signal,
      startIndex: 0,
      deadline,
      onRateLimited: async () => {
        await onProgress(globalCursor, messageTotal, 'Gmail rate limit — waiting a moment...')
      },
      onProgress: async (scannedInSlice) => {
        const globalScanned = globalCursor + scannedInSlice
        const elapsed = Date.now() - startedAt
        const processed = globalScanned - globalCursor
        const rate = processed / Math.max(elapsed, 1)
        const etaMs = rate > 0 ? (messageTotal - globalScanned) / rate : 0
        const etaMins = Math.ceil(etaMs / 60_000)
        const etaText = processed > 0 && globalScanned < messageTotal
          ? (etaMins <= 60
            ? ` · ~${etaMins} min left`
            : ` · ~${Math.ceil(etaMins / 60)} hr left`)
          : ''
        await onProgress(
          globalScanned,
          messageTotal,
          `Reading ${globalScanned.toLocaleString()} / ${messageTotal.toLocaleString()} emails${etaText}`
        )
      },
    })

    globalCursor += sliceCursor
    await upsertSendersList(admin, user.id, chunkSenders)

    clearInterval(cancelPoll)

    const scanComplete = globalCursor >= messageTotal

    if (!scanComplete) {
      await saveScanProgress(admin, user.id, {
        status: 'scanning',
        scanned: globalCursor,
        total: messageTotal,
        cursor: globalCursor,
        list_complete: true,
        phase: `Reading ${globalCursor.toLocaleString()} / ${messageTotal.toLocaleString()} emails · keep tab open`,
      })

      return NextResponse.json({
        continued: true,
        scanned: globalCursor,
        total: messageTotal,
      })
    }

    const profileRes = await gmail.users.getProfile({ userId: 'me' })
    const stats = await finalizeScan(admin, user.id, profileRes.data.historyId ?? null)
    return NextResponse.json({ ...stats, continued: false })
  } catch (err) {
    clearInterval(cancelPoll)

    if (err instanceof ScanCancelledError) {
      await saveScanProgress(admin, user.id, {
        status: 'cancelled',
        phase: 'Scan paused — open dashboard to continue',
        cursor: globalCursor,
        completed_at: new Date().toISOString(),
      })
      return NextResponse.json({ cancelled: true, scanned: globalCursor })
    }

    if (isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', user.id)
      await saveScanProgress(admin, user.id, { status: 'error', phase: 'Gmail access expired', cursor: globalCursor })
      return NextResponse.json(
        { error: 'gmail_auth_expired', message: 'Your Gmail access expired — sign in again to continue' },
        { status: 401 }
      )
    }

    const message = err instanceof Error ? err.message : 'Scan failed'
    await saveScanProgress(admin, user.id, {
      status: 'error',
      phase: `${message} — reopening dashboard will resume`,
      cursor: globalCursor,
    })
    return NextResponse.json({ error: message, continued: true, scanned: globalCursor }, { status: 500 })
  }
}
