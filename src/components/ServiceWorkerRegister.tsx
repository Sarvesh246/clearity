'use client'

import { useEffect } from 'react'

/** Drop legacy caches that previously stored failed /api/scan responses. */
async function purgeLegacyCaches() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter(k => k.startsWith('clearity-') && k !== 'clearity-v4')
      .map(k => caches.delete(k))
  )
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      void purgeLegacyCaches()
      navigator.serviceWorker
        .register('/sw.js')
        .then(reg => {
          void reg.update()
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
        })
        .catch(() => {
          // Non-fatal — app works without offline support.
        })
    }

    // Defer SW install so the first scan click never races SW activation.
    let idleId: number | undefined
    let timerId: ReturnType<typeof setTimeout> | undefined

    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(register, { timeout: 8000 })
    } else {
      timerId = setTimeout(register, 4000)
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
