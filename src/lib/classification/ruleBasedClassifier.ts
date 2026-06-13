import { Classification, ClassificationResult } from '@/types/index'
import { extractFeatures, type SenderSignals } from './features'

// Rule-based fallback classifier. Runs when Gemini is unavailable / over quota.
//
// Design: instead of a single junk score with a low bar, we accumulate
// *separate* junk and safe evidence and compare them. This lets a strong safe
// signal (transactional category, regularly-read mail, a real person) cancel a
// junk signal and vice-versa, which is what keeps notifications you want
// (Garmin, bank alerts) out of junk and unsolicited orgs out of safe.

export function classifyByRules(sender: SenderSignals): ClassificationResult {
  const f = extractFeatures(sender)
  const { domain } = sender

  // --- Tier 1: high-confidence hard rules ---------------------------------

  // Government / military almost never market.
  if (f.isGovMil) {
    return result(domain, 'safe', 0.95, 'Government or military sender')
  }

  // Curated safe domains (banks, healthcare, shipping, dev/account/security,
  // device & service notifications). Matched on the registrable domain so
  // marketing/notification subdomains resolve correctly.
  if (f.inSafeList && f.category !== 'promotions') {
    return result(domain, 'safe', 0.93, 'Known account, transactional, or device-notification sender')
  }

  // Curated marketing/social/newsletter domains — but let an unusually strong
  // safe signal (transactional category, or mail the user clearly reads) pull
  // it back to "unsure" rather than force-junking, e.g. a real receipt from a
  // streaming service.
  if (f.inJunkList) {
    const strongSafe = f.category === 'updates' || f.category === 'personal' ||
      (f.readRatio !== null && f.readRatio <= 0.2)
    if (!strongSafe) {
      return result(domain, 'junk', 0.9, 'Known marketing, social, or newsletter sender')
    }
  }

  // A real person from a personal mailbox.
  if (f.isFreemailPersonal) {
    return result(domain, 'safe', 0.85, 'Appears to be a personal contact')
  }

  // --- Tier 2: weighted evidence ------------------------------------------

  let junk = 0
  let safe = 0
  const reasons: string[] = []

  switch (f.category) {
    case 'promotions':
      junk += 3
      reasons.push('Gmail marked as Promotions')
      break
    case 'social':
      junk += 2
      reasons.push('Gmail marked as Social')
      break
    case 'forums':
      junk += 2
      reasons.push('Gmail marked as Forums / mailing list')
      break
    case 'updates':
      safe += 2
      reasons.push('Gmail marked as Updates (transactional/notifications)')
      break
    case 'personal':
      safe += 3
      reasons.push('Gmail marked as Personal')
      break
  }

  if (f.marketingLocalPart) {
    junk += 2
    reasons.push('sender address looks promotional (e.g. deals@, newsletter@)')
  }
  if (f.transactionalLocalPart) {
    safe += 2
    reasons.push('sender address looks transactional (e.g. alerts@, receipts@)')
  }
  if (f.marketingName) {
    junk += 1
    reasons.push('sender name suggests marketing')
  }
  if (f.personalName) {
    safe += 2
    reasons.push('sender name looks like a real person')
  }

  // Engagement: how much of this sender's mail does the user actually open?
  if (f.readRatio !== null) {
    if (f.readRatio >= 0.9) {
      junk += 2
      reasons.push('almost never opened')
    } else if (f.readRatio <= 0.25) {
      safe += 3
      reasons.push('regularly opened')
    }
  }

  // Sheer volume is a weak junk hint on its own (a service you use can be
  // chatty too), so it's kept small and only counts above a high bar.
  if (f.emailCount > 80) {
    junk += 1
    reasons.push('very high email volume')
  }

  // The unsubscribe header is a *reinforcing* signal only — transactional
  // senders (Garmin, banks, shipping) carry it too, so it must not junk on its
  // own. It adds weight only when other marketing signals already point to junk.
  if (sender.has_unsubscribe_header && (f.category === 'promotions' || f.marketingLocalPart || f.marketingName)) {
    junk += 1
    reasons.push('has an unsubscribe link')
  }
  // Conversely, a sender with no unsubscribe header that Gmail didn't flag as
  // promotional is usually transactional/personal.
  if (!sender.has_unsubscribe_header && f.category !== 'promotions' && f.category !== 'social') {
    safe += 1
    reasons.push('no marketing unsubscribe link')
  }

  // Academic is a weak safe hint, fully overridable by the marketing evidence
  // above — fixes unsolicited .edu recruitment being force-classified safe.
  if (f.isAcademic) {
    safe += 1
    reasons.push('academic (.edu) sender')
  }

  // --- Decide --------------------------------------------------------------

  const margin = junk - safe
  if (margin >= 3) {
    return result(domain, 'junk', clampConfidence(0.55 + margin * 0.05), reasons.join('; '))
  }
  if (margin <= -3) {
    return result(domain, 'safe', clampConfidence(0.55 + -margin * 0.05), reasons.join('; '))
  }

  // Genuinely ambiguous — route to "unsure" rather than defaulting to junk, so
  // mail the user might want to keep is never silently bucketed for deletion.
  return result(domain, 'unsure', 0.5, reasons.length ? reasons.join('; ') : 'No strong signals')
}

function clampConfidence(c: number): number {
  return Math.min(Math.max(c, 0.5), 0.85)
}

function result(
  domain: string,
  classification: Classification,
  confidence: number,
  reason: string
): ClassificationResult {
  return { domain, classification, confidence, method: 'rule_based', reason }
}
