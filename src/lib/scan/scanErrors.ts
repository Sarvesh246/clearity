/** Substring the client uses to detect auto-resuming error states. */
export const AUTO_RESUME_MARKER = 'will resume automatically'

/** Errors that will never succeed on retry — do not auto-resume or schedule workers. */
const FATAL_PATTERNS = [
  'could not find',
  'column',
  'schema cache',
  'permission denied',
  'jwt',
  'invalid api key',
  'relation',
  'does not exist',
  'gmail access expired',
  'not connected',
  'unauthorized',
]

const GMAIL_QUOTA_PATTERNS = [
  'quota exceeded',
  'queries per minute',
  'rate limit exceeded',
  'ratelimitexceeded',
  'userratelimitexceeded',
]

function isGmailQuotaError(message: string): boolean {
  const lower = message.toLowerCase()
  return GMAIL_QUOTA_PATTERNS.some(p => lower.includes(p))
}

export function isRecoverableScanError(message: string): boolean {
  const lower = message.toLowerCase()
  return !FATAL_PATTERNS.some(p => lower.includes(p))
}

function userFacingScanMessage(message: string, partial?: { senderCount: number }): string {
  if (isGmailQuotaError(message)) {
    if (partial && partial.senderCount > 0) {
      return `Gmail is temporarily busy — ${partial.senderCount.toLocaleString()} senders saved so far. Your scan ${AUTO_RESUME_MARKER} in about a minute.`
    }
    return `Gmail is temporarily busy — your scan ${AUTO_RESUME_MARKER} in about a minute.`
  }
  return message
}

export function scanErrorPhase(
  message: string,
  partial?: { senderCount: number }
): string {
  if (!isRecoverableScanError(message)) return message

  const friendly = userFacingScanMessage(message, partial)
  if (friendly !== message) return friendly

  if (partial && partial.senderCount > 0) {
    return `${message} — ${partial.senderCount.toLocaleString()} senders saved, ${AUTO_RESUME_MARKER}`
  }
  return `${message} — ${AUTO_RESUME_MARKER}`
}
