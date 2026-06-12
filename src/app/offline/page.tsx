import { WifiOff } from 'lucide-react'

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-base">
      <div className="w-full max-w-sm flex flex-col items-center gap-6 text-center">
        <div
          className="neu-card flex items-center justify-center"
          style={{ width: 72, height: 72, borderRadius: 20 }}
        >
          <WifiOff size={32} color="#a55eea" strokeWidth={1.75} />
        </div>
        <div className="flex flex-col gap-2">
          <h1
            className="text-2xl font-semibold text-white"
            style={{ letterSpacing: '-0.02em' }}
          >
            You&apos;re offline
          </h1>
          <p className="text-base leading-relaxed" style={{ color: '#8888a0' }}>
            Reconnect to manage your inbox.
          </p>
        </div>
      </div>
    </main>
  )
}
