import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getGmailClient } from '@/lib/gmail/client'
import { listMessageIdsChunk } from '@/lib/gmail/listMessages'
import { CHUNK_TIME_BUDGET_MS, scanMessageIds } from '@/lib/gmail/scanner'
import { incrementalSync } from '@/lib/gmail/incrementalScan'
import { classify } from '@/lib/classification/classify'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import { getRefreshTokenForUser } from '@/lib/gmail/getRefreshTokenForUser'
import {
  clearMessageIds,
  countMessageIds,
  insertMessageIds,
  loadMessageIdsForRange,
} from '@/lib/scan/messageIds'
import { finalizePartialScan } from '@/lib/scan/classifyPartial'
import { loadSendersIntoMap, upsertSendersList } from '@/lib/scan/persistence'
import { tryAcquireChunkLock, releaseChunkLock } from '@/lib/scan/chunkLock'
import { ScanCancelledError } from '@/types'

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

export interface RunScanChunkOptions {
  forceFull?: boolean
  resume?: boolean
  /** Internal worker calls skip lock acquisition (already held). */
  skipLock?: boolean
}

export interface RunScanChunkResult {
  continued?: boolean
  cancelled?: boolean
  incremental?: boolean
  phase?: string
  scanned?: number
  total?: number
  totalMessages?: number
  senderCount?: number
  totalScanned?: number
  error?: string
  skipped?: boolean
  emailCount?: number
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
    updated_at: now,
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
    chunk_locked_at: null,
    updated_at: now,
  }).eq('user_id', userId)

  return { totalMessages, senderCount: senders.length }
}

async function saveScanProgress(
  admin: ReturnType<typeof adminClient>,
  userId: string,
  fields: Record<string, unknown>
) {
  await admin.from('scan_jobs').update({
    ...fields,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId)
}

export async function runScanChunk(
  userId: string,
  options: RunScanChunkOptions = {}
): Promise<RunScanChunkResult> {
  const { forceFull = false, resume: resumeRequested = false, skipLock = false } = options
  const admin = adminClient()

  if (!skipLock) {
    const acquired = await tryAcquireChunkLock(admin, userId)
    if (!acquired) return { skipped: true }
  }

  const runStartedAt = new Date().toISOString()
  let cancelPoll: ReturnType<typeof setInterval> | undefined
  let globalCursor = 0

  try {
    const [{ data: job }, { data: profile }] = await Promise.all([
      admin.from('scan_jobs').select('*').eq('user_id', userId).maybeSingle(),
      admin.from('profiles').select('last_scan_at, gmail_history_id').eq('id', userId).single(),
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
      existingJob?.status !== 'cancelled' &&
      (resumeRequested || existingJob?.status === 'scanning' || existingJob?.status === 'error') &&
      hasIncompleteScan

    const useIncremental =
      !forceFull &&
      !canResume &&
      !!profile?.last_scan_at &&
      !!profile?.gmail_history_id

    globalCursor = cursor

    if (useIncremental) {
      await admin.from('scan_jobs').upsert({
        user_id: userId,
        status: 'scanning',
        action_type: null,
        phase: 'Syncing new emails...',
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
        chunk_locked_at: new Date().toISOString(),
        updated_at: runStartedAt,
      })
    } else if (canResume) {
      await saveScanProgress(admin, userId, {
        status: 'scanning',
        phase: listComplete ? 'Resuming scan...' : 'Resuming email list...',
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
      })
    } else {
      await clearMessageIds(admin, userId)
      await admin.from('user_senders').delete().eq('user_id', userId)
      await admin.from('scan_jobs').upsert({
        user_id: userId,
        status: 'scanning',
        action_type: null,
        phase: 'Connecting to Gmail...',
        scanned: 0,
        total: 0,
        cursor: 0,
        list_page_token: null,
        list_complete: false,
        started_at: runStartedAt,
        cancelled_at: null,
        completed_at: null,
        chunk_locked_at: new Date().toISOString(),
        updated_at: runStartedAt,
      })
    }

    const refreshToken = await getRefreshTokenForUser(admin, userId)
    const gmail = getGmailClient(refreshToken)
    const deadline = Date.now() + CHUNK_TIME_BUDGET_MS

    const ac = new AbortController()
    cancelPoll = setInterval(async () => {
      const { data } = await admin
        .from('scan_jobs')
        .select('status, started_at, cancelled_at')
        .eq('user_id', userId)
        .single()
      if (data?.status !== 'cancelled') return
      const cancelledAt = data.cancelled_at ? new Date(data.cancelled_at).getTime() : 0
      const startedAt = data.started_at ? new Date(data.started_at).getTime() : 0
      if (cancelledAt > startedAt) {
        ac.abort()
        clearInterval(cancelPoll)
      }
    }, 3000)

    const onProgress = async (scanned: number, totalCount: number, phase: string) => {
      await saveScanProgress(admin, userId, { scanned, total: totalCount, phase })
    }

    if (useIncremental) {
      const existingMap = await loadSendersIntoMap(admin, userId)

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
        await admin.from('profiles').update({ gmail_history_id: null }).eq('id', userId)
      }

      if (result) {
        clearInterval(cancelPoll)

        if (result.newMessageCount === 0) {
          await admin.from('profiles').update({
            last_scan_at: new Date().toISOString(),
            gmail_history_id: result.historyId,
          }).eq('id', userId)

          await saveScanProgress(admin, userId, {
            status: 'complete',
            phase: 'Already up to date',
            scanned: result.senders.reduce((n, s) => n + s.email_count, 0),
            total: result.senders.reduce((n, s) => n + s.email_count, 0),
            completed_at: new Date().toISOString(),
            chunk_locked_at: null,
          })

          return { totalScanned: 0, senderCount: result.senders.length, incremental: true }
        }

        await upsertSendersList(admin, userId, result.senders)
        const stats = await finalizeScan(admin, userId, result.historyId)
        return { ...stats, incremental: true }
      }
    }

    const { data: jobState } = await admin
      .from('scan_jobs')
      .select('list_complete, list_page_token, total, cursor')
      .eq('user_id', userId)
      .single()

    let listingDone = jobState?.list_complete ?? false
    let messageTotal = jobState?.total ?? 0
    globalCursor = jobState?.cursor ?? 0
    let listPageToken: string | null = jobState?.list_page_token ?? null

    if (!listingDone) {
      while (Date.now() < deadline) {
        const existingCount = await countMessageIds(admin, userId)

        const chunk = await listMessageIdsChunk(gmail, {
          pageToken: listPageToken,
          deadline,
          signal: ac.signal,
          onProgress: async foundInChunk => {
            const found = existingCount + foundInChunk
            await onProgress(
              0,
              found,
              `Fetching email list… ${found.toLocaleString()} found`
            )
          },
        })

        if (chunk.ids.length > 0) {
          await insertMessageIds(admin, userId, existingCount, chunk.ids)
        }

        messageTotal = await countMessageIds(admin, userId)
        listingDone = chunk.listComplete
        listPageToken = chunk.nextPageToken

        await saveScanProgress(admin, userId, {
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
        return {
          continued: true,
          phase: 'listing',
          total: messageTotal,
          scanned: globalCursor,
        }
      }
    } else {
      messageTotal = jobState?.total ?? await countMessageIds(admin, userId)
    }

    if (messageTotal === 0) {
      clearInterval(cancelPoll)
      const stats = await finalizeScan(
        admin,
        userId,
        (await gmail.users.getProfile({ userId: 'me' })).data.historyId ?? null
      )
      return { ...stats, continued: false }
    }

    const senderMap = await loadSendersIntoMap(admin, userId)
    const ids = await loadMessageIdsForRange(admin, userId, globalCursor, globalCursor + ID_SLICE)

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
    await upsertSendersList(admin, userId, chunkSenders)
    if (chunkSenders.length > 0) {
      await classify(chunkSenders, userId, admin)
    }

    clearInterval(cancelPoll)

    const scanComplete = globalCursor >= messageTotal

    if (!scanComplete) {
      await saveScanProgress(admin, userId, {
        status: 'scanning',
        scanned: globalCursor,
        total: messageTotal,
        cursor: globalCursor,
        list_complete: true,
        phase: `Reading ${globalCursor.toLocaleString()} / ${messageTotal.toLocaleString()} emails · continues in background`,
      })

      return {
        continued: true,
        scanned: globalCursor,
        total: messageTotal,
      }
    }

    const profileRes = await gmail.users.getProfile({ userId: 'me' })
    const stats = await finalizeScan(admin, userId, profileRes.data.historyId ?? null)
    return { ...stats, continued: false }
  } catch (err) {
    clearInterval(cancelPoll)

    if (err instanceof ScanCancelledError) {
      const partial = await finalizePartialScan(admin, userId)
      await saveScanProgress(admin, userId, {
        status: 'cancelled',
        phase: partial.senderCount > 0
          ? `Stopped — ${partial.senderCount.toLocaleString()} senders saved and ready to review`
          : 'Scan cancelled',
        cursor: globalCursor,
        completed_at: new Date().toISOString(),
        chunk_locked_at: null,
      })
      return { cancelled: true, scanned: globalCursor, ...partial }
    }

    if (isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', userId)
      await saveScanProgress(admin, userId, {
        status: 'error',
        phase: 'Gmail access expired',
        cursor: globalCursor,
        chunk_locked_at: null,
      })
      return { error: 'gmail_auth_expired' }
    }

    const message = err instanceof Error ? err.message : 'Scan failed'
    const partial = await finalizePartialScan(admin, userId)
    await saveScanProgress(admin, userId, {
      status: 'error',
      phase: partial.senderCount > 0
        ? `${message} — ${partial.senderCount.toLocaleString()} senders saved, will resume automatically`
        : `${message} — will resume automatically`,
      cursor: globalCursor,
      chunk_locked_at: null,
    })
    return {
      error: message,
      continued: true,
      scanned: globalCursor,
      ...partial,
    }
  } finally {
    if (!skipLock) {
      await releaseChunkLock(admin, userId)
    }
  }
}
