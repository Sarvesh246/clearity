// Shared feature extraction for email-sender classification.
//
// Both the rule-based classifier and the Gemini prompt builder consume the
// same derived signals so the two paths stay consistent. The goal is to reason
// about the *type* of email (transactional, account/security, personal,
// device/service notification, marketing, newsletter, social, cold outreach)
// rather than blunt domain-string matching.

// Bump whenever the classification logic changes in a way that should
// invalidate previously cached domain classifications. `classify()` ignores
// (and recomputes) any `sender_classifications` row stamped with an older
// version, so algorithm improvements reach already-scanned inboxes on their
// next scan/classify without a manual cache wipe.
export const CLASSIFIER_VERSION = 2

export interface SenderSignals {
  domain: string
  sender_email: string
  sender_name: string | null
  has_unsubscribe_header: boolean
  gmail_labels: string[]
  email_count: number
  unread_count: number
}

// ---------------------------------------------------------------------------
// Domain lists
// ---------------------------------------------------------------------------
// Matched against the *registrable* domain, so `email.garmin.com`,
// `mail.chase.com`, etc. all resolve to their root and match these entries.

const SAFE_DOMAINS = new Set([
  // Banks & financial
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com', 'citi.com',
  'capitalone.com', 'discover.com', 'americanexpress.com', 'aexp.com', 'paypal.com',
  'venmo.com', 'stripe.com', 'fidelity.com', 'schwab.com', 'robinhood.com',
  'ally.com', 'sofi.com', 'coinbase.com', 'vanguard.com', 'tdameritrade.com',
  'etrade.com', 'wealthfront.com', 'betterment.com', 'acorns.com', 'usbank.com',
  'pnc.com', 'truist.com', 'tdbank.com', 'navyfederal.org', 'creditkarma.com',
  'mint.com', 'intuit.com', 'turbotax.com', 'quickbooks.com', 'wise.com',
  'cash.app', 'squareup.com', 'creditonebank.com', 'synchrony.com',
  // Healthcare
  'mychart.com', 'epic.com', 'cvs.com', 'walgreens.com', 'optum.com',
  'aetna.com', 'cigna.com', 'uhc.com', 'anthem.com', 'bcbs.com',
  'kaiserpermanente.org', 'labcorp.com', 'questdiagnostics.com', 'goodrx.com',
  'zocdoc.com', 'teladoc.com',
  // Shipping / receipts
  'ups.com', 'fedex.com', 'usps.com', 'dhl.com', 'ontrac.com',
  // Major e-commerce receipts (transactional, not marketing)
  'amazon.com', 'ebay.com', 'etsy.com',
  // Cloud / dev tools / account & security notifications
  'github.com', 'gitlab.com', 'vercel.com', 'supabase.com', 'supabase.io',
  'google.com', 'accounts.google.com', 'apple.com', 'icloud.com', 'microsoft.com',
  'live.com', 'office.com', 'zoom.us', 'twilio.com', 'sendgrid.com', 'netlify.com',
  'cloudflare.com', 'digitalocean.com', 'heroku.com', 'aws.amazon.com', 'azure.com',
  'firebase.google.com', 'atlassian.com', 'slack.com', 'notion.so', 'dropbox.com',
  'box.com', 'figma.com', 'linear.app', 'asana.com', 'trello.com', 'okta.com',
  'auth0.com', '1password.com', 'lastpass.com', 'dashlane.com', 'bitwarden.com',
  'docusign.com', 'docusign.net', 'calendly.com',
  // Utilities / telecom (account & billing)
  'att.com', 'verizon.com', 'tmobile.com', 'comcast.com', 'xfinity.com',
  'spectrum.com', 'coxinc.com', 'cox.com', 'centurylink.com', 'duke-energy.com',
  'pge.com', 'coned.com', 'nationalgrid.com',
  // Device / service notifications people opt into and want to keep
  'garmin.com', 'strava.com', 'fitbit.com', 'whoop.com', 'ouraring.com',
  'oura.com', 'peloton.com', 'myfitnesspal.com', 'ring.com', 'nest.com',
  'wyze.com', 'arlo.com', 'eufylife.com', 'simplisafe.com', 'ecobee.com',
  'myq.com', 'tesla.com', 'rivian.com', 'meross.com', 'tile.com',
  'life360.com', 'find.apple.com',
])

// Senders that are overwhelmingly marketing / promotional / social and that a
// user clearing their inbox almost always wants to clean up.
const JUNK_DOMAINS = new Set([
  // Social
  'linkedin.com', 'facebookmail.com', 'facebook.com', 'notifications.twitter.com',
  'twitter.com', 'tiktok.com', 'instagram.com', 'snapchat.com', 'discord.com',
  'reddit.com', 'pinterest.com', 'tumblr.com', 'mastodon.social', 'threads.net',
  'bsky.social', 'x.com', 'nextdoor.com',
  // Streaming marketing ("new this week" blasts)
  'netflix.com', 'hulu.com', 'spotify.com', 'disneyplus.com', 'hbomax.com',
  'max.com', 'primevideo.com', 'peacocktv.com', 'paramountplus.com',
  'crunchyroll.com', 'funimation.com', 'pandora.com', 'tidal.com', 'deezer.com',
  // Food & delivery promos
  'doordash.com', 'ubereats.com', 'grubhub.com', 'instacart.com',
  'postmates.com', 'seamless.com', 'caviar.com', 'gopuff.com',
  // Retail marketing
  'target.com', 'walmart.com', 'bestbuy.com', 'homedepot.com', 'lowes.com',
  'macys.com', 'nordstrom.com', 'kohls.com', 'gap.com', 'oldnavy.com',
  'hm.com', 'zara.com', 'nike.com', 'adidas.com', 'uniqlo.com', 'asos.com',
  'shein.com', 'temu.com', 'wayfair.com', 'chewy.com', 'costco.com', 'samsclub.com',
  'tjmaxx.com', 'marshalls.com', 'ross.com', 'burlington.com', 'jcpenney.com',
  'sears.com', 'crateandbarrel.com', 'westelm.com', 'potterybarn.com',
  'anthropologie.com', 'urbanoutfitters.com', 'freepeople.com',
  'forever21.com', 'primark.com', 'reebok.com', 'underarmour.com',
  'puma.com', 'newbalance.com', 'vans.com', 'converse.com', 'timberland.com',
  'levi.com', 'calvinklein.com', 'ralphlauren.com', 'tommyhilfiger.com',
  'coach.com', 'katespade.com', 'michaelkors.com', 'gucci.com', 'louisvuitton.com',
  'sephora.com', 'ulta.com', 'bathandbodyworks.com', 'victoriassecret.com',
  'wish.com', 'aliexpress.com', 'overstock.com', 'ikea.com',
  // Travel marketing
  'expedia.com', 'kayak.com', 'booking.com', 'hotels.com', 'airbnb.com',
  'tripadvisor.com', 'travelocity.com', 'orbitz.com', 'priceline.com',
  'hotwire.com', 'vrbo.com', 'hostelworld.com', 'carnival.com',
  'royalcaribbean.com', 'ncl.com', 'princess.com',
  // ESP / marketing platforms (the From domain is the platform itself)
  'mailchimp.com', 'mailchimpapp.com', 'constantcontact.com', 'marketo.com',
  'klaviyo.com', 'klaviyomail.com', 'sendgrid.net', 'mailgun.com',
  'campaignmonitor.com', 'createsend.com', 'activecampaign.com', 'drip.com',
  'omnisend.com', 'sendinblue.com', 'brevo.com', 'mailerlite.com',
  'convertkit.com', 'kit.com', 'aweber.com', 'getresponse.com', 'icontact.com',
  'freshmarketer.com', 'sailthru.com', 'iterable.com', 'braze.com', 'cordial.com',
  // News / media / content newsletters
  'substack.com', 'substackcdn.com', 'medium.com', 'quora.com', 'producthunt.com',
  'buzzfeed.com', 'vox.com', 'huffpost.com', 'businessinsider.com',
  'theguardian.com', 'nytimes.com', 'washingtonpost.com', 'wsj.com',
  'forbes.com', 'fortune.com', 'inc.com', 'entrepreneur.com',
  'fastcompany.com', 'wired.com', 'techcrunch.com', 'theverge.com',
  'engadget.com', 'cnet.com', 'zdnet.com', 'morningbrew.com', 'thehustle.co',
  'axios.com', 'politico.com', 'theathletic.com', 'bleacherreport.com',
  // Gaming marketing
  'ea.com', 'steampowered.com', 'epicgames.com', 'roblox.com', 'twitch.tv',
  'battlenet.com', 'ubisoft.com', 'activision.com', 'blizzard.com',
  'ign.com', 'gamespot.com', 'polygon.com', 'humblebundle.com',
  // Deals / coupons / rewards / education marketing
  'groupon.com', 'yelp.com', 'meetup.com', 'eventbrite.com',
  'duolingo.com', 'udemy.com', 'coursera.com', 'skillshare.com',
  'masterclass.com', 'brilliant.org', 'khanacademy.org',
  'retailmenot.com', 'honey.com', 'rakuten.com', 'swagbucks.com',
  'dosh.com', 'ibotta.com', 'fetchrewards.com',
  // Crypto / fintech marketing
  'binance.com', 'kraken.com', 'crypto.com', 'blockfi.com', 'gemini.com',
])

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.sg', 'com.hk', 'co.in', 'co.za',
])

/** Reduce a raw mail host to its registrable root (eTLD+1), e.g.
 *  `email.marketing.garmin.com` -> `garmin.com`, `foo.gov.uk` -> `foo.gov.uk`. */
export function registrableDomain(host: string): string {
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return host
  const last2 = parts.slice(-2).join('.')
  if (MULTI_PART_TLDS.has(last2)) return parts.slice(-3).join('.')
  return last2
}

function inDomainSet(host: string, set: Set<string>): boolean {
  return set.has(host) || set.has(registrableDomain(host))
}

/** Government / military senders — these effectively never send marketing. */
function isGovOrMil(host: string): boolean {
  return /(^|\.)(gov|mil)$/.test(host) || /\.(gov|mil)\.[a-z]{2}$/.test(host)
}

/** Academic (.edu / .ac.* / .edu.*) — a *weak* safe hint only. Plenty of
 *  unsolicited college recruitment and alumni-marketing comes from .edu, so it
 *  must be overridable by marketing signals rather than a hard safe rule. */
function isAcademic(host: string): boolean {
  return /(^|\.)edu$/.test(host) || /\.(edu|ac)\.[a-z]{2}$/.test(host)
}

// ---------------------------------------------------------------------------
// Local-part / name intent patterns
// ---------------------------------------------------------------------------

// `noreply`, `no-reply`, `donotreply` are used by BOTH marketing and
// transactional senders, so they're intentionally treated as neutral.
const MARKETING_LOCALPART = /^(deals?|offers?|promo(tions?)?|sales?|marketing|newsletter|news|hello|hey|hi|team|weekly|daily|digest|savings?|rewards?|members?|community|connect|stories|story|magazine|campaign|invite|invites|join|shop|store|specials?|exclusive)\b/i

const TRANSACTIONAL_LOCALPART = /^(alerts?|notif(y|ication)s?|receipts?|orders?|invoices?|billing|bill|statements?|payments?|pay|confirm(ation)?|security|secure|account|auth|verify|verification|password|service|care|transaction|txn|ship(ping|ment)?|delivery|tracking|status|reminders?|appointments?|booking|itinerary|fraud)\b/i

const MARKETING_NAME = /\b(deals?|offers?|promo(tions?)?|sales?|marketing|newsletter|rewards|savings|weekly|daily|digest|shop|store|specials?|exclusive)\b/i

const PERSONAL_NAME = /^[A-Z][a-z'-]+ (?:[A-Z]\.? )?[A-Z][a-z'-]+$/

// ---------------------------------------------------------------------------
// Gmail category labels
// ---------------------------------------------------------------------------

const PROMO_LABEL = 'CATEGORY_PROMOTIONS'
const SOCIAL_LABEL = 'CATEGORY_SOCIAL'
const FORUMS_LABEL = 'CATEGORY_FORUMS'
const UPDATES_LABEL = 'CATEGORY_UPDATES' // transactional / notifications — leans SAFE
const PERSONAL_LABEL = 'CATEGORY_PERSONAL'

export type GmailCategory =
  | 'promotions'
  | 'social'
  | 'forums'
  | 'updates'
  | 'personal'
  | 'none'

function gmailCategory(labels: string[]): GmailCategory {
  if (labels.includes(PROMO_LABEL)) return 'promotions'
  if (labels.includes(SOCIAL_LABEL)) return 'social'
  if (labels.includes(FORUMS_LABEL)) return 'forums'
  if (labels.includes(UPDATES_LABEL)) return 'updates'
  if (labels.includes(PERSONAL_LABEL)) return 'personal'
  return 'none'
}

// ---------------------------------------------------------------------------
// Derived feature bundle
// ---------------------------------------------------------------------------

export interface Features {
  host: string
  registrable: string
  localPart: string
  category: GmailCategory
  inSafeList: boolean
  inJunkList: boolean
  isGovMil: boolean
  isAcademic: boolean
  isFreemailPersonal: boolean // someone@gmail.com etc. — likely a real person
  marketingLocalPart: boolean
  transactionalLocalPart: boolean
  marketingName: boolean
  personalName: boolean
  /** fraction of mail left unread (0 = reads everything, 1 = never opens), or
   *  null when the volume is too low to be meaningful. */
  readRatio: number | null
  emailCount: number
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'fastmail.com', 'zoho.com',
])

export function extractFeatures(s: SenderSignals): Features {
  const host = (s.domain || '').toLowerCase()
  const localPart = (s.sender_email?.split('@')[0] ?? '').toLowerCase()
  const name = s.sender_name ?? ''
  const registrable = registrableDomain(host)

  const isFreemail = FREEMAIL.has(registrable)
  // A freemail address with a human-looking name and no unsubscribe header is
  // almost certainly a real person, not a bulk sender.
  const isFreemailPersonal =
    isFreemail && !s.has_unsubscribe_header && PERSONAL_NAME.test(name)

  const readRatio =
    s.email_count >= 4 ? Math.min(s.unread_count / s.email_count, 1) : null

  return {
    host,
    registrable,
    localPart,
    category: gmailCategory(s.gmail_labels ?? []),
    inSafeList: inDomainSet(host, SAFE_DOMAINS),
    inJunkList: inDomainSet(host, JUNK_DOMAINS),
    isGovMil: isGovOrMil(host),
    isAcademic: isAcademic(host),
    isFreemailPersonal,
    marketingLocalPart: MARKETING_LOCALPART.test(localPart),
    transactionalLocalPart: TRANSACTIONAL_LOCALPART.test(localPart),
    marketingName: MARKETING_NAME.test(name),
    personalName: PERSONAL_NAME.test(name),
    readRatio,
    emailCount: s.email_count,
  }
}
