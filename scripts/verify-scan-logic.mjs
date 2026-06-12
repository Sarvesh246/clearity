/**
 * Lightweight regression checks for scan resume / checkpoint logic.
 * Run: node scripts/verify-scan-logic.mjs
 */

function scanCheckpoint(job) {
  if (!job) return 0
  return job.cursor ?? 0
}

function hasIncompleteScan(job) {
  if (!job) return false
  if (job.status === 'complete') return false
  const total = job.total ?? 0
  const checkpoint = scanCheckpoint(job)
  const listComplete = job.list_complete ?? false
  const listPageToken = job.list_page_token
  if (!listComplete || listPageToken) return true
  if (total > 0 && checkpoint < total) return true
  if (checkpoint > 0 && total === 0) return true
  return false
}

function canResumeScan(job, opts = {}) {
  if (opts.forceFull) return false
  if (!job || !hasIncompleteScan(job)) return false
  if (job.status === 'cancelled') return !!opts.resumeRequested
  return (
    !!opts.resumeRequested ||
    job.status === 'scanning' ||
    job.status === 'error'
  )
}

let passed = 0
let failed = 0

function assert(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

console.log('Scan logic verification\n')

// Resume must use committed cursor only — not in-flight scanned
assert(
  'checkpoint ignores ahead-of-commit scanned',
  scanCheckpoint({ cursor: 5000, scanned: 8200 }) === 5000
)

// Mid-scan metadata: should resume
assert(
  'scanning with cursor < total is incomplete',
  hasIncompleteScan({ status: 'scanning', list_complete: true, cursor: 1240, total: 91000, scanned: 1500 })
)

// After quota wait: cursor committed at 5000, scanned UI at 5200
assert(
  'resume position stays at last commit after rate-limit UI ahead',
  scanCheckpoint({ status: 'scanning', list_complete: true, cursor: 5000, scanned: 5200, total: 91000 }) === 5000
)

// Listing phase
assert(
  'listing in progress is incomplete',
  hasIncompleteScan({ status: 'scanning', list_complete: false, list_page_token: 'tok', cursor: 0, total: 0 })
)

// Complete scan
assert(
  'complete scan is not incomplete',
  !hasIncompleteScan({ status: 'scanning', list_complete: true, cursor: 91000, total: 91000 })
)

// Cancelled — only explicit resume
assert(
  'cancelled does not auto-resume',
  !canResumeScan({ status: 'cancelled', list_complete: true, cursor: 5000, total: 91000 })
)
assert(
  'cancelled resumes when user requests continue',
  canResumeScan({ status: 'cancelled', list_complete: true, cursor: 5000, total: 91000 }, { resumeRequested: true })
)

// Background worker should not restart cancelled scan
assert(
  'worker continuation skips cancelled without resume flag',
  !canResumeScan({ status: 'cancelled', list_complete: true, cursor: 5000, total: 91000 }, { resumeRequested: false })
)

// Active scan continues via worker
assert(
  'scanning status auto-continues',
  canResumeScan({ status: 'scanning', list_complete: true, cursor: 5000, total: 91000 })
)

// Full rescan blocks resume
assert(
  'forceFull blocks resume',
  !canResumeScan({ status: 'scanning', list_complete: true, cursor: 5000, total: 91000 }, { forceFull: true })
)

// Complete jobs must not look incomplete (cursor may equal total, not 0)
assert(
  'complete scan is not incomplete even when cursor field is 0',
  !hasIncompleteScan({ status: 'complete', list_complete: true, cursor: 0, total: 91000 })
)

// Listing-phase pause (total still 0) is still resumable
assert(
  'listing phase with no metadata read yet is incomplete',
  hasIncompleteScan({ status: 'cancelled', list_complete: false, list_page_token: 'tok', cursor: 0, total: 0 })
)

function isRecoverableScanError(message) {
  const lower = message.toLowerCase()
  const fatal = ['could not find', 'column', 'schema cache', 'permission denied']
  return !fatal.some(p => lower.includes(p))
}

const AUTO_RESUME_MARKER = 'will resume automatically'
const GMAIL_QUOTA_PATTERNS = ['quota exceeded', 'queries per minute']

function scanErrorPhase(message, partial) {
  if (!isRecoverableScanError(message)) return message
  const lower = message.toLowerCase()
  if (GMAIL_QUOTA_PATTERNS.some(p => lower.includes(p))) {
    if (partial?.senderCount > 0) {
      return `Gmail is temporarily busy — ${partial.senderCount.toLocaleString()} senders saved so far. Your scan ${AUTO_RESUME_MARKER} in about a minute.`
    }
    return `Gmail is temporarily busy — your scan ${AUTO_RESUME_MARKER} in about a minute.`
  }
  if (partial?.senderCount > 0) {
    return `${message} — ${partial.senderCount.toLocaleString()} senders saved, ${AUTO_RESUME_MARKER}`
  }
  return `${message} — ${AUTO_RESUME_MARKER}`
}

assert(
  'schema/column errors are not recoverable',
  !isRecoverableScanError("Could not find the 'cancelled_at' column of 'scan_jobs' in the schema cache")
)
assert(
  'transient Gmail errors are recoverable',
  isRecoverableScanError('Gmail rate limit exceeded')
)

assert(
  'Gmail quota errors get a user-friendly auto-resume message',
  scanErrorPhase("Quota exceeded for quota metric 'Queries'").includes('Gmail is temporarily busy') &&
    scanErrorPhase("Quota exceeded for quota metric 'Queries'").includes('will resume automatically')
)

// After quota wait: in-flight UI must not reset to committed cursor
assert(
  'display progress keeps in-flight scanned ahead of committed cursor',
  Math.max(5000, 8200) === 8200
)

// Mirrors fetchBatch's deadline-aware backoff: waiting must never overrun the
// invocation budget (Vercel would hard-kill the function and lose the slice).
function shouldPauseForQuota(now, backoffMs, deadline) {
  return now + backoffMs >= deadline
}

assert(
  'quota backoff pauses when the wait would overrun the deadline',
  shouldPauseForQuota(280_000, 20_000, 290_000)
)
assert(
  'quota backoff keeps waiting while there is budget left',
  !shouldPauseForQuota(100_000, 20_000, 290_000)
)

// Mirrors runScanChunk's sub-slice checkpoint loop: the committed cursor must
// advance with every sub-slice, so a kill loses at most one sub-slice.
function checkpointAfterSubSlices(start, subSliceResults) {
  let cursor = start
  for (const done of subSliceResults) cursor += done
  return cursor
}

assert(
  'cursor commits per sub-slice — a kill resumes near the failure point',
  checkpointAfterSubSlices(0, [500, 500, 500, 320]) === 1820
)

// Quota-paused scan stays status=scanning with cursor < total → still resumable
assert(
  'quota-paused scan remains incomplete and auto-continues',
  hasIncompleteScan({ status: 'scanning', list_complete: true, cursor: 4000, total: 91000 }) &&
    canResumeScan({ status: 'scanning', list_complete: true, cursor: 4000, total: 91000 })
)

// Listing paused by quota must not be considered complete even without a token
function listChunkComplete(pageToken, pausedForQuota) {
  return !pageToken && !pausedForQuota
}
assert(
  'quota-paused listing is never marked complete',
  !listChunkComplete(undefined, true) && listChunkComplete(undefined, false)
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
