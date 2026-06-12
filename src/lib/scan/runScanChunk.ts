import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getGmailClient } from '@/lib/gmail/client'
import { listMessageIdsChunk } from '@/lib/gmail/listMessages'
import { CHUNK_TIME_BUDGET_MS, scanMessageIds } from '@/lib/gmail/scanner'
import { incrementalSync } from '@/lib/gmail/incrementalScan'
import { classify } from '@/lib/classification/classify'
import { isGoogleTokenExpiry } from '@/lib/gmail/handleTokenExpiry'
import { getRefreshTokenForUser, GmailNotConnectedError } from '@/lib/gmail/getRefreshTokenForUser'
import {
  clearMessageIds,
  countMessageIds,
  filterToNewMessageIds,
  insertMessageIds,
  loadMessageIdsForRange,
} from '@/lib/scan/messageIds'
import { finalizePartialScan } from '@/lib/scan/classifyPartial'
import { loadSendersIntoMap, upsertSendersList } from '@/lib/scan/persistence'
import { tryAcquireChunkLock, releaseChunkLock } from '@/lib/scan/chunkLock'
import {
  canResumeScan,
  hasIncompleteScan,
  scanCheckpoint,
} from '@/lib/scan/scanState'
import { ScanCancelledError } from '@/types'

// One slice per worker invocation. The scan loop stops at the Vercel time budget
// regardless, so this just caps memory and how far a single chunk reads ahead.
const ID_SLICE = 7000

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
  /**
   * Background continuation (worker/cron). Such calls must only RESUME an
   * in-progress scan — never start a fresh or incremental one. This prevents a
   * stray continuation (e.g. fired moments before the user cancels) from wiping
   * saved senders and silently restarting a full rescan.
   */
  continuation?: boolean
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
    cursor: totalMessages,
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
  const { error } = await admin.from('scan_jobs').update({
    ...fields,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId)
  // Surface (don't swallow) write failures — a silently-failing status write
  // makes the whole scan look like it "crashes" with no trace. Logging here is
  // what turns a schema/permissions drift from a mystery into a one-line clue.
  if (error) console.error('[scan] saveScanProgress failed:', error.message)
}

export async function runScanChunk(
  userId: string,
  options: RunScanChunkOptions = {}
): Promise<RunScanChunkResult> {
  const {
    forceFull = false,
    resume: resumeRequested = false,
    skipLock = false,
    continuation = false,
  } = options
  const admin = adminClient()

  if (!skipLock) {
    const acquired = await tryAcquireChunkLock(admin, userId)
    if (!acquired) return { skipped: true }
  }

  const runStartedAt = new Date().toISOString()
  let cancelPoll: ReturnType<typeof setInterval> | undefined
  let globalCursor = 0
  /** Latest checkpoint written to DB — survives mid-chunk aborts / rate-limit waits. */
  let persistedCursor = 0

  try {
    const [{ data: job }, { data: profile }] = await Promise.all([
      admin.from('scan_jobs').select('*').eq('user_id', userId).maybeSingle(),
      admin.from('profiles').select('last_scan_at, gmail_history_id').eq('id', userId).single(),
    ])

    const existingJob = job as ScanJobRow | null

    const canResume = canResumeScan(existingJob, {
      forceFull,
      resumeRequested,
    })

    const useIncremental =
      !forceFull &&
      !canResume &&
      !!profile?.last_scan_at &&
      !!profile?.gmail_history_id

    // A background continuation may only resume in-progress chunked work. Such calls must only RESUME an
    // in-progress scan — never start a fresh or incremental one. This prevents a
    // stray continuation (e.g. fired moments before the user cancels) from wiping
    // saved senders and silently restarting a full rescan.
    if (continuation && !canResume) {
      return { skipped: true }
    }

    globalCursor = scanCheckpoint(existingJob)
    persistedCursor = globalCursor

    if (useIncremental) {
      const { error: incErr } = await admin.from('scan_jobs').upsert({
        user_id: userId,
        status: 'scanning',
        action_type: null,
        phase: 'Syncing new emails...',
        started_at: runStartedAt,
        completed_at: null,
        chunk_locked_at: new Date().toISOString(),
        updated_at: runStartedAt,
      })
      if (incErr) throw new Error(`Failed to start sync: ${incErr.message}`)
    } else if (canResume) {
      const listComplete = existingJob?.list_complete ?? false
      const resumeUpdate = admin
        .from('scan_jobs')
        .update({
          status: 'scanning',
          action_type: null,
          phase: listComplete ? 'Resuming scan...' : 'Resuming email list...',
          started_at: runStartedAt,
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)

      const { data: resumed, error: resumeErr } = await (resumeRequested
        ? resumeUpdate
        : resumeUpdate.neq('status', 'cancelled')
      )
        .select('user_id')
        .maybeSingle()

      if (resumeErr) throw new Error(`Failed to resume scan: ${resumeErr.message}`)
      if (!resumed) {
        return { skipped: true }
      }
    } else {
      if (!forceFull && hasIncompleteScan(existingJob)) {
        return { skipped: true }
      }
      await clearMessageIds(admin, userId)
      await admin.from('user_senders').delete().eq('user_id', userId)
      const { error: startErr } = await admin.from('scan_jobs').upsert({
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
        completed_at: null,
        chunk_locked_at: new Date().toISOString(),
        updated_at: runStartedAt,
      })
      if (startErr) throw new Error(`Failed to start scan: ${startErr.message}`)
      globalCursor = 0
      persistedCursor = 0
    }

    const refreshToken = await getRefreshTokenForUser(admin, userId)
    const gmail = getGmailClient(refreshToken)
    const deadline = Date.now() + CHUNK_TIME_BUDGET_MS

    const ac = new AbortController()
    const runStartedMs = new Date(runStartedAt).getTime()
    cancelPoll = setInterval(async () => {
      const { data, error } = await admin
        .from('scan_jobs')
        .select('status, started_at')
        .eq('user_id', userId)
        .single()
      if (error || !data) return
      // Abort this run if the user cancelled it, or if a newer run took over the
      // row (started_at advanced past ours — possible only after the chunk lock
      // goes stale). Both writers set started_at to their own runStartedAt, so a
      // mismatch means this invocation is no longer the active one.
      const startedMs = data.started_at ? new Date(data.started_at).getTime() : 0
      if (data.status === 'cancelled' || startedMs !== runStartedMs) {
        ac.abort()
        clearInterval(cancelPoll)
      }
    }, 3000)

    const onProgress = async (
      scanned: number,
      totalCount: number,
      phase: string,
      opts?: { commitCursor?: number }
    ) => {
      const fields: Record<string, unknown> = { scanned, total: totalCount, phase }
      if (opts?.commitCursor !== undefined) {
        fields.cursor = opts.commitCursor
        persistedCursor = opts.commitCursor
      }
      await saveScanProgress(admin, userId, fields)
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
      .select('list_complete, list_page_token, total, cursor, scanned')
      .eq('user_id', userId)
      .single()

    let listingDone = jobState?.list_complete ?? false
    let messageTotal = jobState?.total ?? 0
    globalCursor = scanCheckpoint(jobState)
    persistedCursor = globalCursor
    let listPageToken: string | null = jobState?.list_page_token ?? null

    if (!listingDone) {
      // When resuming from a persisted page token, the previous invocation may
      // have inserted IDs but died before saving its next token — the first
      // re-listed chunk can overlap rows already stored. Dedupe just that one.
      let dedupeFirstChunk = listPageToken !== null

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

        let newIds = chunk.ids
        if (dedupeFirstChunk && newIds.length > 0) {
          newIds = await filterToNewMessageIds(admin, userId, newIds)
        }
        dedupeFirstChunk = false

        if (newIds.length > 0) {
          await insertMessageIds(admin, userId, existingCount, newIds)
        }

        messageTotal = await countMessageIds(admin, userId)
        listingDone = chunk.listComplete
        listPageToken = chunk.nextPageToken

        await saveScanProgress(admin, userId, {
          list_page_token: listPageToken,
          list_complete: listingDone,
          total: messageTotal,
          scanned: persistedCursor,
          cursor: persistedCursor,
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
          scanned: persistedCursor,
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
      const actualCount = await countMessageIds(admin, userId)

      if (actualCount === 0) {
        // ID table lost — re-list without wiping senders or zeroing the checkpoint.
        await saveScanProgress(admin, userId, {
          status: 'scanning',
          phase: `Rebuilding email list (resuming from ${persistedCursor.toLocaleString()})...`,
          list_page_token: null,
          list_complete: false,
          total: 0,
          scanned: persistedCursor,
          cursor: persistedCursor,
        })
        clearInterval(cancelPoll)
        return { continued: true, scanned: persistedCursor, total: messageTotal }
      }

      if (globalCursor >= actualCount) {
        const profileRes = await gmail.users.getProfile({ userId: 'me' })
        clearInterval(cancelPoll)
        const stats = await finalizeScan(admin, userId, profileRes.data.historyId ?? null)
        return { ...stats, continued: false }
      }

      // Transient read gap — retry on next chunk with corrected total.
      messageTotal = actualCount
      await saveScanProgress(admin, userId, {
        total: messageTotal,
        scanned: persistedCursor,
        cursor: persistedCursor,
        phase: `Reading ${persistedCursor.toLocaleString()} / ${messageTotal.toLocaleString()} emails · retrying`,
      })
      clearInterval(cancelPoll)
      return { continued: true, scanned: persistedCursor, total: messageTotal }
    }

    const sliceBase = globalCursor
    const startedAt = Date.now()
    const { cursor: sliceCursor, chunkSenders } = await scanMessageIds(gmail, ids, senderMap, {
      signal: ac.signal,
      startIndex: 0,
      deadline,
      onRateLimited: async () => {
        await onProgress(
          persistedCursor,
          messageTotal,
          'Gmail rate limit — waiting a moment...'
        )
      },
      onProgress: async (scannedInSlice) => {
        const globalScanned = sliceBase + scannedInSlice
        const elapsed = Date.now() - startedAt
        const processed = globalScanned - sliceBase
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

    globalCursor = sliceBase + sliceCursor
    if (chunkSenders.length > 0) {
      await upsertSendersList(admin, userId, chunkSenders)
      await classify(chunkSenders, userId, admin)
    }
    persistedCursor = globalCursor
    await saveScanProgress(admin, userId, {
      scanned: globalCursor,
      cursor: globalCursor,
      total: messageTotal,
    })

    if (ac.signal.aborted) {
      clearInterval(cancelPoll)
      const partial = await finalizePartialScan(admin, userId)
      await saveScanProgress(admin, userId, {
        status: 'cancelled',
        phase: partial.senderCount > 0
          ? `Stopped — ${partial.senderCount.toLocaleString()} senders saved and ready to review`
          : 'Scan cancelled',
        scanned: globalCursor,
        cursor: globalCursor,
        completed_at: new Date().toISOString(),
        chunk_locked_at: null,
      })
      return { cancelled: true, scanned: globalCursor, ...partial }
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
        scanned: persistedCursor,
        cursor: persistedCursor,
        completed_at: new Date().toISOString(),
        chunk_locked_at: null,
      })
      return { cancelled: true, scanned: persistedCursor, ...partial }
    }

    // Both cases need the user to sign in again — never auto-retry these, or a
    // background continuation chain would loop forever against a dead token.
    if (err instanceof GmailNotConnectedError || isGoogleTokenExpiry(err)) {
      await admin.from('profiles').update({ google_refresh_token: null }).eq('id', userId)
      await saveScanProgress(admin, userId, {
        status: 'error',
        phase: 'Gmail access expired',
        scanned: persistedCursor,
        cursor: persistedCursor,
        chunk_locked_at: null,
      })
      return { error: 'gmail_auth_expired', continued: false }
    }

    const message = err instanceof Error ? err.message : 'Scan failed'
    const partial = await finalizePartialScan(admin, userId)
    await saveScanProgress(admin, userId, {
      status: 'error',
      phase: partial.senderCount > 0
        ? `${message} — ${partial.senderCount.toLocaleString()} senders saved, will resume automatically`
        : `${message} — will resume automatically`,
      scanned: persistedCursor,
      cursor: persistedCursor,
      chunk_locked_at: null,
    })
    return {
      error: message,
      continued: true,
      scanned: persistedCursor,
      ...partial,
    }
  } finally {
    if (!skipLock) {
      await releaseChunkLock(admin, userId)
    }
  }
}
