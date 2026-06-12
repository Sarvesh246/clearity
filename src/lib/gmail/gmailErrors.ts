/** Shared classification of googleapis/gaxios errors for retry decisions. */

export function getHttpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
    ?? (err as { status?: number })?.status
    ?? (typeof (err as { code?: unknown })?.code === 'number'
      ? (err as { code: number }).code
      : undefined)
}

export function isRateLimit(err: unknown): boolean {
  const status = getHttpStatus(err)
  if (status === 429) return true
  // Gmail sometimes signals user-rate limits as 403 with a specific reason.
  const reason = (err as { errors?: Array<{ reason?: string }> })?.errors?.[0]?.reason
  return status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
}

/** Messages deleted/moved between listing and fetching return 404/410. */
export function isGone(err: unknown): boolean {
  const status = getHttpStatus(err)
  return status === 404 || status === 410
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND',
])

/** Server-side 5xx or a dropped connection — both safe to retry. */
export function isTransient(err: unknown): boolean {
  const status = getHttpStatus(err)
  if (status === 500 || status === 502 || status === 503 || status === 504) return true
  const code = (err as { code?: unknown })?.code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
  const message = err instanceof Error ? err.message : ''
  return message.includes('socket hang up') || message.includes('network socket disconnected')
}
