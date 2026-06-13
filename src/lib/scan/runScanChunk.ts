import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getGmailClient } from '@/lib/gmail/client'
import { listMessageIdsChunk } from '@/lib/gmail/listMessages'
import { AdaptiveThrottle as ScanThrottle, CHUNK_TIME_BUDGET_MS, scanMessageIds, type SenderData } from '@/lib/gmail/scanner'
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
import { isRecoverableScanError, scanErrorPhase } from '@/lib/scan/scanErrors'
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
  /** Chunk stopped early because Gmail is rate-limiting — reschedule with a delay. */
  quotaPaused?: boolean
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
  if (error) {
    console.error('[scan] saveScanProgress failed:', error.message)
    throw new Error(error.message)
  }
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
  /**
   * Set when the cancel-poll detects a NEWER run has taken over this user's
   * scan_jobs row (its started_at advanced past ours). A superseded run must
   * abandon quietly: it must NOT write cancelled/error status or release the
   * lock, or it would clobber the active run that just started (the stop→start
   * race). Distinct from a plain user cancel, where we DO write terminal state.
   */
  let supersededByNewerRun = false
  /**
   * True once this run has claimed the row by writing started_at = runStartedAt.
   * Gates the ownership-guarded lock release: a claimed run releases only if it
   * still owns the row; an unclaimed run (early `skipped` return) releases
   * unconditionally — it holds the lock exclusively and must free it, not leak
   * it for the 6-min stale window.
   */
  let ownsRow = false
  let globalCursor = 0
  /** Latest checkpoint written to DB — survives mid-chunk aborts / rate-limit waits. */
  let persistedCursor = 0
  /** In-flight read position within the current slice — may be ahead of persistedCursor. */
  let inFlightScanned = 0

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
    inFlightScanned = globalCursor

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
      ownsRow = true
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
      ownsRow = true
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
      ownsRow = true
      globalCursor = 0
      persistedCursor = 0
      inFlightScanned = 0
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
        if (startedMs !== runStartedMs) supersededByNewerRun = true
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
            deadline,
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
    inFlightScanned = globalCursor
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
            : chunk.pausedForQuota
              ? `Gmail is temporarily busy — ${messageTotal.toLocaleString()} emails found so far, resuming shortly...`
              : `Fetching email list… ${messageTotal.toLocaleString()} found`,
        })

        if (chunk.pausedForQuota) {
          clearInterval(cancelPoll)
          return {
            continued: true,
            quotaPaused: true,
            phase: 'listing',
            total: messageTotal,
            scanned: persistedCursor,
          }
        }

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
    inFlightScanned = sliceBase
    const startedAt = Date.now()

    // Read the slice in small sub-slices, committing senders + cursor after
    // each. This bounds what a crash, hard kill, or quota pause can lose to
    // ~CHECKPOINT_EVERY messages. Previously the cursor only advanced once per
    // 7k slice — a Gmail quota stall could overrun the function's lifetime and
    // the kill threw away the whole slice, restarting the read from the chunk
    // start on every retry (the "progress resets to 0" loop).
    const CHECKPOINT_EVERY = 500
    const touchedEmails = new Set<string>()
    let quotaPaused = false
    // One throttle for the whole chunk: its learned rate and any active backoff
    // must persist across sub-slices, or each 500-message sub-slice would reset
    // to START_RPS and re-trip Gmail's limit right after backing off.
    const throttle = new ScanThrottle()

    const reportReadProgress = async (globalScanned: number) => {
      inFlightScanned = globalScanned
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
    }

    while (globalCursor - sliceBase < ids.length) {
      if (Date.now() >= deadline || ac.signal.aborted) break

      const offset = globalCursor - sliceBase
      const subIds = ids.slice(offset, offset + CHECKPOINT_EVERY)
      const subBase = globalCursor

      const sub = await scanMessageIds(gmail, subIds, senderMap, {
        signal: ac.signal,
        startIndex: 0,
        deadline,
        throttle,
        onRateLimited: async () => {
          await onProgress(
            inFlightScanned,
            messageTotal,
            'Gmail is temporarily busy — pausing for a moment...'
          )
        },
        onProgress: async scannedInSub => reportReadProgress(subBase + scannedInSub),
      })

      if (sub.chunkSenders.length > 0) {
        await upsertSendersList(admin, userId, sub.chunkSenders)
        for (const s of sub.chunkSenders) touchedEmails.add(s.sender_email)
      }
      // Commit the cursor only after the senders covering it are persisted —
      // resume must never skip messages whose senders were not saved.
      globalCursor = subBase + sub.cursor
      persistedCursor = globalCursor
      inFlightScanned = Math.max(inFlightScanned, globalCursor)
      await saveScanProgress(admin, userId, {
        scanned: globalCursor,
        cursor: globalCursor,
        total: messageTotal,
      })

      if (sub.pausedForQuota) {
        quotaPaused = true
        break
      }
      // Deadline or cancellation ended the sub-slice early.
      if (sub.cursor < subIds.length) break
    }

    // Classify once per chunk. Safe even if this invocation dies here: the
    // cursor is already committed, and finalizePartialScan / finalizeScan
    // classify any senders left unclassified.
    const sendersToClassify = [...touchedEmails]
      .map(email => senderMap.get(email))
      .filter((s): s is SenderData => !!s)
    if (sendersToClassify.length > 0) {
      await classify(sendersToClassify, userId, admin)
    }

    if (ac.signal.aborted) {
      clearInterval(cancelPoll)
      if (supersededByNewerRun) {
        // A newer run owns the row now — leave its status, cursor, and lock alone.
        return { cancelled: true, scanned: globalCursor }
      }
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

    if (quotaPaused && globalCursor < messageTotal) {
      // Not an error — progress is committed; a delayed continuation resumes
      // from the saved cursor once Gmail's per-minute quota recovers.
      await saveScanProgress(admin, userId, {
        status: 'scanning',
        scanned: globalCursor,
        total: messageTotal,
        cursor: globalCursor,
        list_complete: true,
        phase: `Gmail is temporarily busy — ${globalCursor.toLocaleString()} / ${messageTotal.toLocaleString()} emails saved, resuming shortly...`,
      })
      return {
        continued: true,
        quotaPaused: true,
        scanned: globalCursor,
        total: messageTotal,
      }
    }

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

    // A newer run has taken over this user's scan_jobs row; abandon quietly so a
    // dead run's error/cancel state can't overwrite the active run's progress.
    if (supersededByNewerRun) {
      return { cancelled: true, scanned: persistedCursor }
    }

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
    const recoverable = isRecoverableScanError(message)
    const partial = await finalizePartialScan(admin, userId)
    const displayScanned = Math.max(persistedCursor, inFlightScanned)
    await saveScanProgress(admin, userId, {
      status: 'error',
      phase: scanErrorPhase(message, partial),
      scanned: displayScanned,
      cursor: persistedCursor,
      chunk_locked_at: null,
    })
    return {
      error: message,
      continued: recoverable,
      scanned: displayScanned,
      ...partial,
    }
  } finally {
    if (!skipLock) {
      // If we claimed the row, release only while we still own it (started_at
      // unchanged) so a newer run that took over keeps its lock. If we never
      // claimed it (early skip), release unconditionally — we hold the lock
      // exclusively and must free it rather than leak it for 6 minutes.
      await releaseChunkLock(admin, userId, ownsRow ? runStartedAt : undefined)
    }
  }
}
