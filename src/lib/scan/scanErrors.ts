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

export function isRecoverableScanError(message: string): boolean {
  const lower = message.toLowerCase()
  return !FATAL_PATTERNS.some(p => lower.includes(p))
}

export function scanErrorPhase(
  message: string,
  partial?: { senderCount: number }
): string {
  if (!isRecoverableScanError(message)) return message
  if (partial && partial.senderCount > 0) {
    return `${message} — ${partial.senderCount.toLocaleString()} senders saved, will resume automatically`
  }
  return `${message} — will resume automatically`
}
