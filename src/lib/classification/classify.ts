import { SupabaseClient } from '@supabase/supabase-js'
import { SenderData } from '@/lib/gmail/scanner'
import { ClassificationResult, QuotaExceededError } from '@/types/index'
import { classifyWithGemini } from './geminiClassifier'
import { classifyByRules } from './ruleBasedClassifier'
import { CLASSIFIER_VERSION } from './features'

export async function classify(
  senders: SenderData[],
  userId: string,
  adminClient: SupabaseClient,
): Promise<void> {
  if (senders.length === 0) return

  // Deduplicate by domain — pick the sender with the highest email_count as representative
  const domainMap = new Map<string, SenderData>()
  for (const s of senders) {
    const existing = domainMap.get(s.domain)
    if (!existing || s.email_count > existing.email_count) {
      domainMap.set(s.domain, s)
    }
  }
  const uniqueDomains = Array.from(domainMap.values())
  const allDomains = uniqueDomains.map(s => s.domain)

  // Bulk-fetch cached domain classifications. Chunked: .in() puts every value
  // in the request URL (length-limited) and a single select caps at 1000 rows —
  // either silently drops cache hits for large inboxes and re-burns AI quota.
  const cachedMap = new Map<string, ClassificationResult>()
  const IN_CHUNK = 200
  for (let i = 0; i < allDomains.length; i += IN_CHUNK) {
    const { data: cached, error } = await adminClient
      .from('sender_classifications')
      .select('domain,classification,confidence,method,reason,classifier_version')
      .gte('classifier_version', CLASSIFIER_VERSION)
      .in('domain', allDomains.slice(i, i + IN_CHUNK))
    if (error) throw new Error(error.message)
    for (const row of cached ?? []) {
      cachedMap.set(row.domain, {
        domain: row.domain,
        classification: row.classification,
        confidence: row.confidence ?? 0.8,
        method: row.method as 'ai' | 'rule_based',
        reason: row.reason ?? '',
      })
    }
  }

  const uncached = uniqueDomains.filter(s => !cachedMap.has(s.domain))

  // Classify uncached domains
  const newResults: ClassificationResult[] = []
  if (uncached.length > 0) {
    try {
      const aiResults = await classifyWithGemini(uncached)
      newResults.push(...aiResults)
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // Quota hit — fall back all uncached to rule-based
        for (const s of uncached) {
          newResults.push(classifyByRules(s))
        }
      } else {
        throw err
      }
    }
  }

  // Upsert new results to sender_classifications cache
  if (newResults.length > 0) {
    const now = new Date().toISOString()
    const rows = newResults.map(r => ({
      domain: r.domain,
      classification: r.classification,
      confidence: r.confidence,
      method: r.method,
      reason: r.reason,
      classifier_version: CLASSIFIER_VERSION,
      classified_at: now,
      updated_at: now,
    }))
    await adminClient
      .from('sender_classifications')
      .upsert(rows, { onConflict: 'domain' })
  }

  // Merge cache + new into a domain→result map
  const domainResults = new Map<string, ClassificationResult>([
    ...cachedMap,
    ...newResults.map(r => [r.domain, r] as [string, ClassificationResult]),
  ])

  // Fetch user overrides (paginated past the 1000-row cap)
  const overrideMap = new Map<string, 'safe' | 'junk'>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data: overrides } = await adminClient
      .from('user_sender_overrides')
      .select('sender_email,override')
      .eq('user_id', userId)
      .order('sender_email', { ascending: true })
      .range(from, from + PAGE - 1)
    if (!overrides?.length) break
    for (const o of overrides) overrideMap.set(o.sender_email, o.override)
    if (overrides.length < PAGE) break
  }

  // Build per-sender update rows
  const updates = senders.map(s => {
    const result = domainResults.get(s.domain)
    const override = overrideMap.get(s.sender_email)

    return {
      user_id: userId,
      sender_email: s.sender_email,
      classification: override ?? result?.classification ?? 'unsure',
      classification_method: result?.method ?? 'rule_based',
    }
  })

  // Batch-upsert in chunks of 500
  const BATCH = 500
  for (let i = 0; i < updates.length; i += BATCH) {
    await adminClient
      .from('user_senders')
      .upsert(updates.slice(i, i + BATCH), { onConflict: 'user_id,sender_email' })
  }
}
