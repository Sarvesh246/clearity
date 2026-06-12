import { GoogleGenerativeAI } from '@google/generative-ai'
import { ClassificationResult, QuotaExceededError } from '@/types/index'
import { classifyByRules } from './ruleBasedClassifier'

const BATCH_SIZE = 20

interface SenderInput {
  domain: string
  sender_name: string | null
  has_unsubscribe_header: boolean
  gmail_labels: string[]
  email_count: number
}

interface GeminiItem {
  domain: string
  classification: 'junk' | 'safe' | 'unsure'
  confidence: number
  reason: string
}

const PROMPT_TEMPLATE = `You are classifying email senders as junk/marketing or safe/important.

For each sender below, return a JSON array with: domain, classification ("junk"|"safe"|"unsure"), confidence (0-1), reason (one sentence).

Rules:
- "junk": newsletters, marketing, promotions, social notifications, deal alerts, any sender the user likely wants to clean up
- "safe": banks, financial institutions, universities, government, healthcare, employers, personal contacts, transactional receipts the user needs
- "unsure": genuinely ambiguous — when in doubt lean "junk" since the user can always override

Senders:
SENDERS_JSON

Return ONLY valid JSON array. No explanation.`

export async function classifyWithGemini(senders: SenderInput[]): Promise<ClassificationResult[]> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

  const results: ClassificationResult[] = []

  for (let i = 0; i < senders.length; i += BATCH_SIZE) {
    const batch = senders.slice(i, i + BATCH_SIZE)

    const senderDescriptors = batch.map(s => ({
      domain: s.domain,
      senderName: s.sender_name,
      hasUnsubscribeHeader: s.has_unsubscribe_header,
      gmailLabels: s.gmail_labels,
      emailCount: s.email_count,
    }))

    const prompt = PROMPT_TEMPLATE.replace('SENDERS_JSON', JSON.stringify(senderDescriptors, null, 2))

    let responseText: string
    try {
      const response = await model.generateContent(prompt)
      responseText = response.response.text()
    } catch (err: unknown) {
      const status = (err as { status?: number; httpStatusCode?: number })?.status
        ?? (err as { httpStatusCode?: number })?.httpStatusCode
      if (status === 429) throw new QuotaExceededError()
      // Non-quota error: fall back entire batch to rule-based
      for (const s of batch) {
        results.push(classifyByRules(s))
      }
      continue
    }

    // Parse JSON — strip markdown fences if present
    const json = responseText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()

    let parsed: GeminiItem[]
    try {
      parsed = JSON.parse(json)
    } catch {
      // Malformed JSON: fall back entire batch to rule-based
      for (const s of batch) {
        results.push(classifyByRules(s))
      }
      continue
    }

    // Map parsed results back to batch items; fall back individually on mismatch
    const parsedByDomain = new Map(parsed.map(p => [p.domain, p]))
    for (const s of batch) {
      const item = parsedByDomain.get(s.domain)
      if (item && ['junk', 'safe', 'unsure'].includes(item.classification)) {
        results.push({
          domain: s.domain,
          classification: item.classification,
          confidence: Math.min(Math.max(item.confidence ?? 0.7, 0), 1),
          method: 'ai',
          reason: item.reason ?? 'AI classification',
        })
      } else {
        results.push(classifyByRules(s))
      }
    }
  }

  return results
}
