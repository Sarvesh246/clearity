'use client'

import { useEffect } from 'react'

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const register = async () => {
      // Wipe every registration + cache first — old SWs replayed cached 500s
      // for POST /api/scan (0ms failures until devtools was opened).
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.filter(k => k.startsWith('clearity-')).map(k => caches.delete(k)))
      }

      try {
        const reg = await navigator.serviceWorker.register('/sw.js')
        await reg.update()
      } catch {
        // Non-fatal — app works without offline support.
      }
    }

    let idleId: number | undefined
    let timerId: ReturnType<typeof setTimeout> | undefined

    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => { void register() }, { timeout: 10000 })
    } else {
      timerId = setTimeout(() => { void register() }, 5000)
    }

    return () => {
      if (idleId !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId)
      }
      if (timerId !== undefined) clearTimeout(timerId)
    }
  }, [])

  return null
}
