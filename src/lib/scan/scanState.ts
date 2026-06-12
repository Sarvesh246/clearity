/** Shared scan-job predicates — keep resume / continuation logic consistent. */

export interface ScanJobProgress {
  status?: string | null
  phase?: string | null
  scanned?: number | null
  total?: number | null
  cursor?: number | null
  list_page_token?: string | null
  list_complete?: boolean | null
}

export function scanCheckpoint(job: ScanJobProgress | null | undefined): number {
  if (!job) return 0
  // `cursor` is the committed read position (advanced only after a successful
  // upsert). `scanned` may run ahead for UI during an in-flight chunk — never
  // use it for resume or we'd skip emails that were never persisted.
  return job.cursor ?? 0
}

/** UI / progress bar position — may be ahead of the committed cursor. */
export function scanDisplayProgress(job: ScanJobProgress | null | undefined): number {
  if (!job) return 0
  return Math.max(job.cursor ?? 0, job.scanned ?? 0)
}

export function hasIncompleteScan(job: ScanJobProgress | null | undefined): boolean {
  if (!job) return false
  if (job.status === 'complete') return false

  const total = job.total ?? 0
  const checkpoint = scanCheckpoint(job)
  const listComplete = job.list_complete ?? false
  const listPageToken = job.list_page_token

  if (!listComplete || listPageToken) return true
  if (total > 0 && checkpoint < total) return true
  // Early listing: no total yet but listing already started
  if (checkpoint > 0 && total === 0) return true

  return false
}

export function canResumeScan(
  job: ScanJobProgress | null | undefined,
  opts: { forceFull?: boolean; resumeRequested?: boolean } = {}
): boolean {
  if (opts.forceFull) return false
  if (!job || !hasIncompleteScan(job)) return false

  if (job.status === 'cancelled') {
    return !!opts.resumeRequested
  }

  return (
    !!opts.resumeRequested ||
    job.status === 'scanning' ||
    job.status === 'error'
  )
}

export function isMetadataPhase(job: ScanJobProgress | null | undefined): boolean {
  return !!job?.list_complete && (job.total ?? 0) > 0
}
