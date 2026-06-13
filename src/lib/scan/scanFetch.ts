/** Scan API fetches — always bypass HTTP cache and any SW layer. */

export interface ScanPostResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

export async function postScanChunk(
  body: Record<string, unknown> | { full?: boolean; resume?: boolean },
  signal?: AbortSignal
): Promise<ScanPostResult> {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
    // Hint to the browser that this is time-sensitive user work.
    priority: 'high',
  } as RequestInit)

  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

export async function fetchScanProgress(signal?: AbortSignal) {
  return fetch('/api/scan/progress', {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    signal,
  })
}
