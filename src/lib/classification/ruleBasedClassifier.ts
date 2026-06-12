import { Classification, ClassificationResult } from '@/types/index'

const SAFE_DOMAINS = new Set([
  // Banks & financial
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com',
  'capitalone.com', 'discover.com', 'americanexpress.com', 'paypal.com',
  'venmo.com', 'stripe.com', 'fidelity.com', 'schwab.com', 'robinhood.com',
  'ally.com', 'sofi.com', 'coinbase.com', 'vanguard.com', 'tdameritrade.com',
  'etrade.com', 'wealthfront.com', 'betterment.com', 'acorns.com',
  // Healthcare
  'mychart.com', 'epic.com', 'cvs.com', 'walgreens.com', 'optum.com',
  'aetna.com', 'cigna.com', 'uhc.com', 'anthem.com', 'bcbs.com',
  // Shipping / receipts
  'ups.com', 'fedex.com', 'usps.com', 'dhl.com',
  // Major e-commerce receipts (transactional, not marketing)
  'amazon.com', 'ebay.com', 'etsy.com',
  // Cloud / dev tools
  'github.com', 'gitlab.com', 'vercel.com', 'supabase.com', 'supabase.io',
  'google.com', 'apple.com', 'microsoft.com', 'zoom.us', 'twilio.com',
  'sendgrid.com', 'netlify.com', 'cloudflare.com', 'digitalocean.com',
  'heroku.com', 'aws.amazon.com', 'azure.com', 'firebase.google.com',
  // Utilities / telecom
  'att.com', 'verizon.com', 'tmobile.com', 'comcast.com', 'spectrum.com',
])

const SAFE_TLDS = new Set(['.edu', '.gov', '.mil'])

const JUNK_DOMAINS = new Set([
  // Social
  'linkedin.com', 'facebookmail.com', 'notifications.twitter.com',
  'tiktok.com', 'instagram.com', 'snapchat.com', 'discord.com', 'reddit.com',
  'pinterest.com', 'tumblr.com', 'mastodon.social', 'threads.net',
  'bsky.social', 'x.com',
  // Streaming
  'netflix.com', 'hulu.com', 'spotify.com', 'disneyplus.com', 'hbomax.com',
  'max.com', 'primevideo.com', 'appletv.com', 'peacocktv.com', 'paramountplus.com',
  'crunchyroll.com', 'funimation.com', 'pandora.com', 'tidal.com', 'deezer.com',
  // Food & delivery
  'doordash.com', 'ubereats.com', 'grubhub.com', 'instacart.com',
  'postmates.com', 'seamless.com', 'caviar.com', 'gopuff.com',
  // Retail marketing
  'target.com', 'walmart.com', 'bestbuy.com', 'homedepot.com', 'lowes.com',
  'macys.com', 'nordstrom.com', 'kohls.com', 'gap.com', 'oldnavy.com',
  'hm.com', 'zara.com', 'nike.com', 'adidas.com', 'uniqlo.com', 'asos.com',
  'shein.com', 'wayfair.com', 'chewy.com', 'costco.com', 'samsclub.com',
  'tjmaxx.com', 'marshalls.com', 'ross.com', 'burlington.com', 'jcpenney.com',
  'sears.com', 'crateandbarrel.com', 'westelm.com', 'potterybarn.com',
  'anthropologie.com', 'urbanoutfitters.com', 'freepeople.com',
  'forever21.com', 'primark.com', 'reebok.com', 'underarmour.com',
  'puma.com', 'newbalance.com', 'vans.com', 'converse.com', 'timberland.com',
  'levi.com', 'calvinklein.com', 'ralphlauren.com', 'tommyhilfiger.com',
  'coach.com', 'katespade.com', 'michaelkors.com', 'gucci.com', 'louisvuitton.com',
  // Travel
  'expedia.com', 'kayak.com', 'booking.com', 'hotels.com', 'airbnb.com',
  'tripadvisor.com', 'united.com', 'delta.com', 'southwest.com', 'aa.com',
  'jetblue.com', 'hilton.com', 'marriott.com', 'hyatt.com', 'ihg.com',
  'wyndham.com', 'bestwestern.com', 'travelocity.com', 'orbitz.com',
  'priceline.com', 'hotwire.com', 'vrbo.com', 'hostelworld.com',
  'carnival.com', 'royalcaribbean.com', 'ncl.com', 'princess.com',
  'alaskaair.com', 'spirit.com', 'frontier.com', 'allegiantair.com',
  // ESP / marketing platforms
  'mailchimp.com', 'constantcontact.com', 'hubspot.com', 'salesforce.com',
  'marketo.com', 'klaviyo.com', 'sendgrid.net', 'mailgun.com',
  'campaignmonitor.com', 'activecampaign.com', 'drip.com', 'omnisend.com',
  'sendinblue.com', 'brevo.com', 'mailerlite.com', 'convertkit.com',
  'aweber.com', 'getresponse.com', 'icontact.com', 'freshmarketer.com',
  // News / media / content
  'substack.com', 'medium.com', 'quora.com', 'producthunt.com',
  'buzzfeed.com', 'vox.com', 'huffpost.com', 'businessinsider.com',
  'theguardian.com', 'nytimes.com', 'washingtonpost.com', 'wsj.com',
  'forbes.com', 'fortune.com', 'inc.com', 'entrepreneur.com',
  'fastcompany.com', 'wired.com', 'techcrunch.com', 'theverge.com',
  'engadget.com', 'cnet.com', 'zdnet.com', 'ycombinator.com',
  'hackernews.com', 'slashdot.org',
  // Gaming
  'ea.com', 'steampowered.com', 'epicgames.com', 'xbox.com',
  'playstation.com', 'roblox.com', 'twitch.tv', 'battlenet.com',
  'ubisoft.com', 'activision.com', 'blizzard.com', 'nintendo.com',
  'ign.com', 'gamespot.com', 'polygon.com',
  // Misc marketing / deals / coupons
  'groupon.com', 'yelp.com', 'meetup.com', 'eventbrite.com',
  'duolingo.com', 'udemy.com', 'coursera.com', 'skillshare.com',
  'masterclass.com', 'brilliant.org', 'khan.academy.org',
  'retailmenot.com', 'honey.com', 'rakuten.com', 'swagbucks.com',
  'bankoffers.com', 'dosh.com',
  // Crypto / fintech marketing
  'binance.com', 'kraken.com', 'crypto.com', 'blockfi.com',
])

const JUNK_NAME_PATTERN = /newsletter|noreply|no-reply|notifications?|updates?|alerts?|marketing|promo|info|support|hello|hi\b|news|digest|weekly|daily|team|donotreply|do-not-reply/i

const JUNK_DOMAIN_PREFIX_PATTERN = /^(mail|email|news|newsletter|marketing|notify|alerts?|noreply|no-reply|updates?|promo|info|notifications?)\./i

const PERSONAL_NAME_PATTERN = /^[A-Z][a-z]+ [A-Z][a-z]+$/

const JUNK_GMAIL_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
  'CATEGORY_UPDATES',
])

interface SenderInput {
  domain: string
  sender_name: string | null
  has_unsubscribe_header: boolean
  gmail_labels: string[]
  email_count: number
}

export function classifyByRules(sender: SenderInput): ClassificationResult {
  const { domain, sender_name, has_unsubscribe_header, gmail_labels, email_count } = sender

  // Tier 1: definite safe — explicit domain list
  if (SAFE_DOMAINS.has(domain)) {
    return result(domain, 'safe', 0.95, 'rule_based', 'Known safe domain (financial, shipping, or dev tool)')
  }

  // Tier 1: definite safe — TLD
  const tld = domain.match(/(\.[a-z]{2,})$/)?.[1]
  if (tld && SAFE_TLDS.has(tld)) {
    return result(domain, 'safe', 0.95, 'rule_based', `Trusted TLD (${tld})`)
  }

  // Tier 2: definite junk — explicit domain list
  if (JUNK_DOMAINS.has(domain)) {
    return result(domain, 'junk', 0.9, 'rule_based', 'Known marketing or social domain')
  }

  // Tier 3: signal scoring
  let score = 0
  const reasons: string[] = []

  if (has_unsubscribe_header) {
    score += 3
    reasons.push('has unsubscribe header')
  }

  const hasJunkLabel = gmail_labels.some(l => JUNK_GMAIL_LABELS.has(l))
  if (hasJunkLabel) {
    score += 3
    reasons.push('Gmail categorized as promotions/social/forums/updates')
  }

  if (email_count > 50) {
    score += 4
    reasons.push('very high email volume (>50)')
  } else if (email_count > 20) {
    score += 2
    reasons.push('high email volume (>20)')
  }

  if (sender_name && JUNK_NAME_PATTERN.test(sender_name)) {
    score += 1
    reasons.push('sender name suggests automated sender')
  }

  if (JUNK_DOMAIN_PREFIX_PATTERN.test(domain)) {
    score += 1
    reasons.push('domain prefix suggests mailing system')
  }

  if (sender_name && PERSONAL_NAME_PATTERN.test(sender_name)) {
    score -= 2
    reasons.push('sender name looks like a real person')
  }

  if (score >= 3) {
    const confidence = Math.min(0.5 + score * 0.05, 0.85)
    return result(domain, 'junk', confidence, 'rule_based', reasons.join('; ') || 'Signal-based junk classification')
  }

  if (score <= -2) {
    return result(domain, 'safe', 0.7, 'rule_based', reasons.join('; ') || 'Signal-based safe classification')
  }

  return result(domain, 'unsure', 0.5, 'rule_based', reasons.length ? reasons.join('; ') : 'No strong signals')
}

function result(
  domain: string,
  classification: Classification,
  confidence: number,
  method: 'rule_based',
  reason: string
): ClassificationResult {
  return { domain, classification, confidence, method, reason }
}
