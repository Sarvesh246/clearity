import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { calculateHealthScore } from '@/lib/scoring'
import { hasIncompleteScan } from '@/lib/scan/scanState'
import DashboardContent from './DashboardContent'
import ErrorBoundary from '@/components/ErrorBoundary'
import { fetchAllRows } from '@/lib/supabase/fetchAllRows'
import type { UserSender } from '@/types'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const [{ data: profile }, allSenders, { data: scanJob }] = await Promise.all([
    supabase.from('profiles').select('last_scan_at').eq('id', user.id).single(),
    // Paginated — a single select caps at 1000 rows, which would skew the
    // health score and junk/safe counts for large inboxes.
    fetchAllRows<UserSender>((from, to) =>
      supabase
        .from('user_senders')
        .select('*')
        .eq('user_id', user.id)
        .order('id', { ascending: true })
        .range(from, to)
    ).catch(() => [] as UserSender[]),
    supabase.from('scan_jobs').select('status, scanned, total, cursor, list_complete, list_page_token').eq('user_id', user.id).maybeSingle(),
  ])
  const health = calculateHealthScore(allSenders)
  const isPartialScan =
    allSenders.length > 0 &&
    scanJob != null &&
    hasIncompleteScan(scanJob) &&
    (scanJob.status === 'cancelled' || scanJob.status === 'scanning' || scanJob.status === 'error')

  const junkCount      = allSenders.filter(s => s.classification === 'junk').length
  const unsureCount    = allSenders.filter(s => s.classification === 'unsure').length
  const safeCount      = allSenders.filter(s => s.classification === 'safe').length
  const junkEmailTotal = allSenders
    .filter(s => s.classification === 'junk')
    .reduce((sum, s) => sum + s.email_count, 0)

  const fullName  = (user.user_metadata?.full_name as string | undefined) ?? ''
  const firstName = fullName.split(' ')[0] || user.email?.split('@')[0] || 'there'

  return (
    <main className="app-page">
      <div className="app-container app-container--wide">
        <ErrorBoundary>
          <DashboardContent
            firstName={firstName}
            lastScanAt={profile?.last_scan_at ?? null}
            health={health}
            junkCount={junkCount}
            unsureCount={unsureCount}
            safeCount={safeCount}
            junkEmailTotal={junkEmailTotal}
            senderCount={allSenders.length}
            isPartialScan={isPartialScan}
          />
        </ErrorBoundary>
      </div>
    </main>
  )
}
