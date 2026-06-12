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
  const cursor = job.cursor ?? 0
  const scanned = job.scanned ?? 0
  return Math.max(cursor, scanned)
}

export function hasIncompleteScan(job: ScanJobProgress | null | undefined): boolean {
  if (!job) return false

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
  if (!job || job.status === 'cancelled') return false
  if (!hasIncompleteScan(job)) return false

  return (
    !!opts.resumeRequested ||
    job.status === 'scanning' ||
    job.status === 'error'
  )
}

export function isMetadataPhase(job: ScanJobProgress | null | undefined): boolean {
  return !!job?.list_complete && (job.total ?? 0) > 0
}
