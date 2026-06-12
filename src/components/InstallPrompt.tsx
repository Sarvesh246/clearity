'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Share, Plus } from 'lucide-react'

const DISMISS_KEY = 'installPromptDismissed'
const DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000

type Platform = 'ios' | 'android' | null

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return null
}

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false)
  const [platform, setPlatform] = useState<Platform>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)

  useEffect(() => {
    // Already installed as standalone — don't show
    if (window.matchMedia('(display-mode: standalone)').matches) return

    // Dismissed recently — don't show
    const dismissed = localStorage.getItem(DISMISS_KEY)
    if (dismissed && Date.now() - Number(dismissed) < DISMISS_DURATION) return

    const p = detectPlatform()
    if (!p) return

    if (p === 'android') {
      const handler = (e: Event) => {
        e.preventDefault()
        setDeferredPrompt(e)
        setPlatform('android')
        setVisible(true)
      }
      window.addEventListener('beforeinstallprompt', handler)
      return () => window.removeEventListener('beforeinstallprompt', handler)
    }

    if (p === 'ios') {
      // Deferred so the effect doesn't set state synchronously during mount
      const timer = setTimeout(() => {
        setPlatform('ios')
        setVisible(true)
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [])

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setVisible(false)
  }

  async function install() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') setVisible(false)
    setDeferredPrompt(null)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '100%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 36 }}
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 60,
            padding: '12px 16px',
            paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
          }}
        >
          <div
            className="neu-card"
            style={{ borderRadius: 20, padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="text-white font-semibold" style={{ fontSize: 15 }}>
                Add to Home Screen
              </span>
              <button
                onClick={dismiss}
                className="neu-button flex items-center justify-center"
                style={{ width: 32, height: 32, color: '#8888a0' }}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>

            {platform === 'ios' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 13, color: '#8888a0', lineHeight: 1.5 }}>
                  Install this app for the best experience:
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    className="neu-inset flex items-center justify-center flex-shrink-0"
                    style={{ width: 32, height: 32, borderRadius: 8 }}
                  >
                    <Share size={14} color="#45aaf2" strokeWidth={1.75} />
                  </div>
                  <p style={{ fontSize: 13, color: '#e8e8f0' }}>
                    Tap <strong>Share</strong>, then{' '}
                    <strong>Add to Home Screen</strong>
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    className="neu-inset flex items-center justify-center flex-shrink-0"
                    style={{ width: 32, height: 32, borderRadius: 8 }}
                  >
                    <Plus size={14} color="#26de81" strokeWidth={1.75} />
                  </div>
                  <p style={{ fontSize: 13, color: '#e8e8f0' }}>
                    Tap <strong>Add</strong> to confirm
                  </p>
                </div>
              </div>
            )}

            {platform === 'android' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 13, color: '#8888a0', lineHeight: 1.5 }}>
                  Install Inbox Recovery for faster access — works offline too.
                </p>
                <button
                  onClick={install}
                  className="neu-button w-full"
                  style={{
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 500,
                    color: '#a55eea',
                  }}
                >
                  Install App
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
