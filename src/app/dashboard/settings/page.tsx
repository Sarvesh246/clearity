import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { signOut } from '@/app/actions/auth'
import { ArrowLeft, Mail, LogOut } from 'lucide-react'
import Link from 'next/link'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8 bg-base">
      <div className="w-full max-w-[672px] flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="neu-button flex items-center justify-center"
            style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0 }}
          >
            <ArrowLeft size={18} strokeWidth={1.75} style={{ color: '#8888a0' }} />
          </Link>
          <h1
            className="text-2xl font-bold text-white"
            style={{ letterSpacing: '-0.03em' }}
          >
            Settings
          </h1>
        </div>

        {/* Account card */}
        <div className="neu-card flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#555568' }}>
            Account
          </p>
          <div className="flex items-center gap-3">
            <div
              className="neu-inset flex items-center justify-center flex-shrink-0"
              style={{ width: 40, height: 40, borderRadius: 12 }}
            >
              <Mail size={18} color="#a55eea" strokeWidth={1.75} />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-medium" style={{ color: '#8888a0' }}>Signed in as</span>
              <span className="text-sm font-semibold text-white truncate">{user.email}</span>
            </div>
          </div>
        </div>

        {/* Actions card */}
        <div className="neu-card flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#555568' }}>
            Actions
          </p>
          <Link
            href="/dashboard"
            className="neu-button w-full flex items-center justify-center gap-2 px-6 py-4 text-white font-medium text-base"
          >
            Back to Dashboard
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="neu-button w-full flex items-center justify-center gap-2 px-6 py-3 font-medium text-sm"
              style={{ color: '#e84141' }}
            >
              <LogOut size={16} strokeWidth={1.75} />
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
