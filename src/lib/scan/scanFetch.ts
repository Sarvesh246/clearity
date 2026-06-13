'use client'

/** Scan API fetches — cache-bust and bypass any stale SW / HTTP cache layers. */

export interface ScanPostResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

/** Remove legacy service workers that cached failed POST /api/scan responses. */
export async function purgeScanServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map(r => r.unregister()))
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k.startsWith('clearity-')).map(k => caches.delete(k)))
  }
}

export async function postScanChunk(
  body: Record<string, unknown> | { full?: boolean; resume?: boolean },
  signal?: AbortSignal
): Promise<ScanPostResult> {
  // Unique URL prevents replay of cached 500 responses (0ms failures).
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const res = await fetch(`/api/scan?n=${nonce}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
    priority: 'high',
  } as RequestInit)

  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

export async function fetchScanProgress(signal?: AbortSignal) {
  const nonce = Date.now()
  return fetch(`/api/scan/progress?n=${nonce}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    signal,
  })
}
