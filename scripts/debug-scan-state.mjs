/**
 * One-off diagnostic: dump scan_jobs + message-id checkpoint state.
 * Run: node scripts/debug-scan-state.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const { data: jobs, error } = await admin.from('scan_jobs').select('*')
if (error) {
  console.error('scan_jobs error:', error.message)
  process.exit(1)
}

const now = Date.now()
for (const job of jobs ?? []) {
  const age = f => (job[f] ? `${Math.round((now - new Date(job[f]).getTime()) / 1000)}s ago` : 'null')
  console.log({
    user_id: job.user_id,
    status: job.status,
    phase: job.phase,
    scanned: job.scanned,
    cursor: job.cursor,
    total: job.total,
    list_complete: job.list_complete,
    list_page_token: job.list_page_token ? `${String(job.list_page_token).slice(0, 12)}…` : null,
    action_type: job.action_type,
    started_at: age('started_at'),
    updated_at: age('updated_at'),
    completed_at: age('completed_at'),
    chunk_locked_at: age('chunk_locked_at'),
  })

  const { count } = await admin
    .from('scan_message_ids')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', job.user_id)
  const { count: senderCount } = await admin
    .from('user_senders')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', job.user_id)
  console.log({ stored_message_ids: count, senders: senderCount })
}
