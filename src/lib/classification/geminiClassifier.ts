import { GoogleGenerativeAI } from '@google/generative-ai'
import { ClassificationResult, QuotaExceededError } from '@/types/index'
import { classifyByRules } from './ruleBasedClassifier'
import { extractFeatures, type SenderSignals, type GmailCategory } from './features'

const BATCH_SIZE = 20

interface GeminiItem {
  domain: string
  classification: 'junk' | 'safe' | 'unsure'
  confidence: number
  reason: string
}

const CATEGORY_LABEL: Record<GmailCategory, string> = {
  promotions: 'Promotions (Gmail flagged as marketing)',
  social: 'Social (social-network notification)',
  forums: 'Forums (mailing list / group)',
  updates: 'Updates (Gmail flagged as transactional/notification)',
  personal: 'Personal (Gmail flagged as a personal message)',
  none: 'none',
}

const PROMPT_TEMPLATE = `You are an email triage assistant for an inbox-cleanup tool. Users bulk-delete or bulk-unsubscribe whole CATEGORIES at once, so a wrong label causes them to lose mail they wanted OR keep mail they don't. Be precise.

Classify each sender as one of:
- "safe"  = mail the user likely wants to KEEP
- "junk"  = mail the user likely wants to CLEAN UP (delete/unsubscribe)
- "unsure" = genuinely ambiguous — use this instead of guessing

Think about the TYPE of relationship and the sender's intent, not just the domain:

KEEP as "safe":
- Transactional: receipts, order/shipping confirmations, invoices, statements, tickets, itineraries.
- Account & security: sign-in alerts, password resets, 2FA, verification, fraud/billing notices.
- Device & service notifications the user opted into: fitness trackers (Garmin, Strava, Fitbit, Whoop, Oura), smart-home/security (Ring, Nest, Wyze), cars (Tesla), calendar invites, app activity (GitHub, project tools). These are wanted even though they ship from a brand and often have an unsubscribe link.
- The user's own institutions: their bank, healthcare provider, insurer, utility, employer, the school they actually attend.
- Personal mail from real individuals.
- Government / official notices.

CLEAN UP as "junk":
- Marketing & promotions: sales, discounts, "X% off", product launches, "we miss you", abandoned-cart, loyalty/rewards blasts.
- Newsletters & content digests (Substack, Medium, news outlets, blogs) — even ones the user signed up for.
- Social-media notifications (LinkedIn, Facebook, Instagram, X, Reddit).
- Cold / unsolicited outreach: recruiters, sales pitches, and organizations the user has no real relationship with — including colleges/universities sending recruitment, alumni-donation, or event blasts. A .edu address does NOT make a sender safe.
- Surveys, webinars, and re-engagement campaigns.

Decision guidance:
- Do NOT treat an unsubscribe link as proof of junk — transactional and device-notification senders include it too. Weigh the Gmail category, the sender address, and how often the user opens the mail.
- "Promotions" category + promotional sender address + rarely opened => junk.
- "Updates" category, transactional sender address (alerts@, receipts@, no-reply for a service), or mail the user opens regularly => lean safe.
- When evidence genuinely conflicts or is thin, return "unsure" — do not default to junk.

Examples:
- {domain:"garmin.com", senderName:"Garmin", fromAddress:"no-reply@garmin.com", gmailCategory:"Updates", hasUnsubscribe:true, percentUnread:8} -> {"classification":"safe","reason":"Opted-in device activity notifications the user reads"}
- {domain:"okstate.edu", senderName:"OSU Admissions", fromAddress:"admissions@okstate.edu", gmailCategory:"Promotions", hasUnsubscribe:true, percentUnread:96} -> {"classification":"junk","reason":"Unsolicited college recruitment, never opened"}
- {domain:"chase.com", senderName:"Chase", fromAddress:"alerts@chase.com", gmailCategory:"Updates", hasUnsubscribe:false, percentUnread:20} -> {"classification":"safe","reason":"Bank account alerts"}
- {domain:"target.com", senderName:"Target", fromAddress:"deals@e.target.com", gmailCategory:"Promotions", hasUnsubscribe:true, percentUnread:99} -> {"classification":"junk","reason":"Retail marketing"}
- {domain:"substack.com", senderName:"Some Newsletter", fromAddress:"newsletter@substack.com", gmailCategory:"Promotions", hasUnsubscribe:true, percentUnread:70} -> {"classification":"junk","reason":"Content newsletter"}

For each sender return an object: {domain, classification, confidence (0-1), reason (one short sentence)}.

Senders:
SENDERS_JSON

Return ONLY a valid JSON array, one object per sender, no markdown, no commentary.`

function describe(s: SenderSignals) {
  const f = extractFeatures(s)
  return {
    domain: s.domain,
    senderName: s.sender_name,
    fromAddress: s.sender_email,
    gmailCategory: CATEGORY_LABEL[f.category],
    hasUnsubscribe: s.has_unsubscribe_header,
    emailCount: s.email_count,
    percentUnread: f.readRatio === null ? null : Math.round(f.readRatio * 100),
  }
}

export async function classifyWithGemini(senders: SenderSignals[]): Promise<ClassificationResult[]> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  // gemini-1.5-flash was retired; requests to it 404 and silently degraded
  // every batch to rule-based classification.
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const results: ClassificationResult[] = []

  for (let i = 0; i < senders.length; i += BATCH_SIZE) {
    const batch = senders.slice(i, i + BATCH_SIZE)

    const prompt = PROMPT_TEMPLATE.replace(
      'SENDERS_JSON',
      JSON.stringify(batch.map(describe), null, 2)
    )

    let responseText: string
    try {
      const response = await model.generateContent(prompt)
      responseText = response.response.text()
    } catch (err: unknown) {
      const status = (err as { status?: number; httpStatusCode?: number })?.status
        ?? (err as { httpStatusCode?: number })?.httpStatusCode
      const message = err instanceof Error ? err.message : ''
      // The SDK sometimes wraps quota failures in a plain Error whose message
      // carries the status — detect those too so the caller can stop burning
      // requests and fall back to rules for the rest of the run.
      if (status === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
        throw new QuotaExceededError()
      }
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
