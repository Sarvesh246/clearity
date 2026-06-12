'use client'

import { useEffect } from 'react'

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    navigator.serviceWorker
      .register('/sw.js')
      .then(reg => {
        // Pick up SW fixes (e.g. stop caching API errors) without waiting for
        // the user to close every tab.
        void reg.update()
      })
      .catch(() => {
        // Non-fatal — app works without offline support.
      })
  }, [])

  return null
}
