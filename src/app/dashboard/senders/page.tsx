import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Settings } from 'lucide-react'
import type { Classification } from '@/types'
import SenderList from '@/components/SenderList'
import ErrorBoundary from '@/components/ErrorBoundary'

export default async function SendersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/')

  const [sendersResult, overridesResult] = await Promise.all([
    supabase
      .from('user_senders')
      .select('*')
      .eq('user_id', user.id)
      .order('email_count', { ascending: false }),
    supabase
      .from('user_sender_overrides')
      .select('sender_email, override')
      .eq('user_id', user.id),
  ])

  if (sendersResult.error) redirect('/dashboard')

  const overrideMap = new Map(
    (overridesResult.data ?? []).map(o => [o.sender_email, o.override as Classification])
  )

  const senders = (sendersResult.data ?? []).map(s => ({
    ...s,
    classification: (overrideMap.get(s.sender_email) ?? s.classification) as Classification | null,
  }))

  return (
    <main className="min-h-screen flex flex-col bg-base">
      {/* Nav bar */}
      <nav
        className="neu-card !p-0 !rounded-none w-full"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
          paddingTop: 'env(safe-area-inset-top)',
          minHeight: 'calc(56px + env(safe-area-inset-top))',
          borderBottom: '1px solid #2c2c35',
        }}
      >
        <Link
          href="/dashboard"
          className="neu-button flex items-center gap-1"
          style={{ padding: '6px 10px', color: '#e8e8f0', fontSize: 14 }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
          Back
        </Link>
        <span
          className="font-semibold text-white"
          style={{ fontSize: 15, letterSpacing: '-0.02em' }}
        >
          Inbox Recovery
        </span>
        <Link
          href="/dashboard/settings"
          className="neu-button flex items-center justify-center"
          style={{ width: 40, height: 40, color: '#8888a0' }}
          aria-label="Settings"
        >
          <Settings size={16} strokeWidth={1.75} />
        </Link>
      </nav>

      <div style={{ maxWidth: 672, margin: '0 auto', width: '100%', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary>
          <SenderList senders={senders} />
        </ErrorBoundary>
      </div>
    </main>
  )
}
