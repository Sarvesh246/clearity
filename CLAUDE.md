# Clearity — Inbox Recovery Tool

## Status: Stage 15 Complete — Production polish (June 2026)

Production URL: **https://clearitymail.vercel.app**

Clearity scans a user's Gmail inbox (metadata only — no email bodies), groups messages **by sender address**, classifies senders as junk/safe/unsure, and lets users bulk-delete, archive, mark-read, or unsubscribe+delete. Built for large inboxes (~200k+ emails) with resumable background scans.

---

## Stack

- **Next.js 16.2** App Router, TypeScript, React 19
- **Tailwind CSS v4** — tokens in `src/app/globals.css` (`@theme` block); no `tailwind.config.ts`
- **Supabase** — auth (Google OAuth) + Postgres + RLS
- **Gmail API** — scan, list, batchModify, send (mailto unsubscribe)
- **Gemini 2.5 Flash** — sender classification (rule-based fallback)
- **Framer Motion** — UI animations
- **PWA** — manifest, service worker, install prompt, offline page
- **Vercel** — serverless functions (`maxDuration=300` on scan/action routes), `waitUntil` for background scan continuation

---

## Design System

- Neumorphism on charcoal base `#1a1a1e`
- Surface: `#222228`; shadows: light `#2c2c35` / dark `#111116`
- Accents: red `#e84141`, green `#26de81`, amber `#ffb142`, blue `#45aaf2`, purple `#a55eea`
- Font: **Space Grotesk** (Google Fonts + `next/font`)
- Utility classes: `.neu-card`, `.neu-button`, `.neu-inset`, `.neu-button:active`
- Tailwind tokens: `bg-base`, `bg-surface`, `text-accent-red`, `shadow-neu`, etc.
- App shell: `.app-page`, `.app-container` (672px mobile; dashboard wide layout 1040px on lg)
- Safe-area insets for PWA/notch devices
- `@media (prefers-reduced-motion: reduce)` disables transitions
- `focus-visible` ring for keyboard nav

---

## Routes & Pages

| Route | File | Description |
|-------|------|-------------|
| `/` | `src/app/page.tsx` | Landing; Sign in with Google; Gmail-auth-expired banner |
| `/dashboard` | `src/app/dashboard/page.tsx` + `DashboardContent.tsx` | Health score, stats, scan/sync CTAs, partial-scan UI (`force-dynamic`) |
| `/dashboard/senders` | `src/app/dashboard/senders/page.tsx` + `SenderList.tsx` | Review & clean inbox (`force-dynamic`) |
| `/dashboard/settings` | `src/app/dashboard/settings/page.tsx` | Email, sign out |
| `/offline` | `src/app/offline/page.tsx` | PWA offline fallback |
| `/auth/callback` | `src/app/auth/callback/route.ts` | Supabase OAuth callback; profile upsert |

**Auth proxy:** `src/proxy.ts` — redirects unauthenticated users from `/dashboard` and `/scan` to `/` (Next.js 16 middleware renamed to proxy).

**Layouts:** `src/app/layout.tsx` — PWA meta, viewport, `ServiceWorkerRegister`, Space Grotesk.

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/scan` | Start/resume/full/incremental scan chunk (`maxDuration=300`) |
| POST | `/api/scan/continue` | Background worker continuation (bearer `SCAN_WORKER_SECRET`) |
| POST | `/api/scan/cancel` | Cancel in-progress scan; keeps partial results |
| GET | `/api/scan/progress` | Current `scan_jobs` row (no-cache) |
| GET | `/api/senders` | Fresh sender list for client refresh (no-cache) |
| POST | `/api/actions` | Bulk trash / mark_read / archive (`maxDuration=300`) |
| POST | `/api/unsubscribe` | Unsubscribe ± delete (`maxDuration=300`) |
| POST | `/api/classify` | Re-classify unclassified senders without re-scan |
| POST | `/api/overrides` | User safe/junk override per sender |
| GET | `/api/cron/resume-scans` | Cron safety net for stalled scans (`CRON_SECRET`) |

All scan/action JSON responses use `Cache-Control: no-store` via `src/lib/api/scanResponse.ts`.

---

## Database Schema

Apply `supabase/schema.sql` manually in Supabase SQL editor (includes Stage 6–11 migrations).

### Tables

**profiles**
- `id` (FK auth.users), `email`, `google_refresh_token`, `last_scan_at`, `gmail_history_id`, `created_at`

**user_senders** — one row per unique `From` email address
- `id`, `user_id`, `sender_email`, `sender_name`, `domain`
- `email_count`, `unread_count`
- `has_unsubscribe_header`, `unsubscribe_mailto`, `unsubscribe_url`, `unsubscribe_post`
- `gmail_labels[]`, `classification`, `classification_method`, `is_unsubscribed`, `last_scanned_at`
- UNIQUE `(user_id, sender_email)`

**user_sender_overrides** — manual safe/junk; always wins over AI/rules
- `(user_id, sender_email)` PK, `override`

**sender_classifications** — shared domain cache across users
- `domain` PK, `classification`, `confidence`, `method`, `reason`
- `classifier_version` (only reused when `>=` app's `CLASSIFIER_VERSION`)
- `classified_at`, `updated_at`

**scan_jobs** — one row per user (upserted by service role)
- `user_id` PK, `status`, `phase`, `scanned`, `total`, `started_at`, `completed_at`
- `action_type`, `processed`, `sender_statuses` JSONB, `unsubscribe_statuses` JSONB
- **Stage 11:** `cursor`, `list_page_token`, `list_complete`, `chunk_locked_at`, `updated_at`
- Cancel tracked via `status='cancelled'` + `completed_at` (no `cancelled_at` column)

**scan_message_ids** — persisted message IDs for resumable scans (not JSONB)
- `(user_id, idx)` PK, `message_id`

All tables have RLS; scan writes use service role where needed.

---

## Architecture Overview

### Data model: sender-centric (not per-email UI)

- Scanner merges every message into a `Map<sender_email, SenderData>` (`mergeMessageIntoSenderMap` in `scanner.ts`).
- One sender with 500 emails = **one** `user_senders` row with `email_count: 500`.
- Unsubscribe runs **once per sender** (one List-Unsubscribe attempt per address).
- Delete/archive/mark-read fetches all message IDs for that sender, then `batchModify` in chunks of 1000.

Grouping is by exact `From` email — same brand using `deals@` vs `noreply@` appears as separate senders.

### Scan pipeline (resumable, 200k+)

```
POST /api/scan → runScanChunk (240s budget)
  ├─ Phase A: list message IDs → scan_message_ids + list_page_token
  └─ Phase B: messages.get metadata → merge into senders → upsert user_senders
       ├─ Sub-slices of 500 msgs; cursor committed after each upsert
       ├─ classify unclassified senders per chunk
       └─ On time budget / quota: save state, schedule continuation
waitUntil → POST /api/scan/continue (SCAN_WORKER_SECRET)
Cron backup → GET /api/cron/resume-scans (daily on Hobby; needs CRON_SECRET)
```

**Key files:**
- `src/lib/scan/runScanChunk.ts` — orchestration, cancel poll, quota pause, partial finalize
- `src/lib/gmail/scanner.ts` — adaptive throttle, `CHUNK_TIME_BUDGET_MS=240_000`, `scanMessageIds`
- `src/lib/gmail/listMessages.ts` — paginated listing with quota pause
- `src/lib/scan/chunkLock.ts` — atomic compare-and-swap lock (`chunk_locked_at`)
- `src/lib/scan/scheduleContinuation.ts` — `waitUntil` + delayed retry
- `src/lib/scan/persistence.ts` — `upsertSendersList`, `loadSendersIntoMap`
- `src/lib/scan/classifyPartial.ts` — `classifyUnclassifiedSenders`, `finalizePartialScan`
- `src/lib/scan/scanState.ts` — `scanCheckpoint`, `hasIncompleteScan`, `canResumeScan`
- `src/lib/scan/scanErrors.ts` — friendly quota copy, `AUTO_RESUME_MARKER`, recoverable vs fatal
- `src/lib/gmail/incrementalScan.ts` — `history.list` after `gmail_history_id` stored

**Progress semantics:**
- `cursor` = committed read position (resume uses this only).
- `scanned` may run ahead for UI during an in-flight chunk.
- Quota pause is NOT an error — friendly phase, auto-continues after ~45s.

**Cancel:** saves partial results; `finalizePartialScan` classifies + updates `last_scan_at`; senders remain reviewable.

### Classification

`src/lib/classification/` — two-tier engine:
1. **Gemini 2.5 Flash** — batches of 20 domains; `QuotaExceededError` → silent rule-based for remainder
2. **Rule-based fallback** — ~150 safe/junk domain lists + signal scoring (List-Unsubscribe, Gmail labels, frequency, name patterns)

- Cache: `sender_classifications` by domain; `CLASSIFIER_VERSION=2` in `features.ts`
- User overrides always win (`user_sender_overrides`)
- Runs after each scan chunk + `finalizePartialScan` / `finalizeScan` sweep

### Bulk actions

`src/lib/gmail/processSendersInterleaved.ts` — collect IDs + act **one sender at a time** (concurrency 3), `ACTION_TIME_BUDGET_MS=240_000`:
- Progress advances continuously; partial work saved if time budget hit
- `src/lib/gmail/getMessageIds.ts` — `messages.list` with quoted `from:"..."` queries
- `src/lib/gmail/bulkActions.ts` — `trashMessages`, `markAsRead`, `archiveMessages`; batchModify 1000/chunk; `withGmailRetry`
- `src/lib/scan/actionGuard.ts` — 409 if scan running; holds chunk lock with 60s heartbeat

### Unsubscribe engine

`src/lib/gmail/unsubscribe.ts` — HTTP-first cascade (Stage 14 fix for bounces):
1. RFC 8058 one-click POST (`unsubscribe_post` + URL)
2. Plain GET on unsubscribe URL
3. Mailto **only** when no URL exists (`buildUnsubscribeEmail.ts` + `parseMailto`)

`POST /api/unsubscribe`:
- Phase 1: unsubscribe eligible senders (max 5 concurrent)
- Phase 2: trash all selected senders' emails (`deleteAfter: false` for Unsubscribe Only)
- Updates `is_unsubscribed`, zeros `email_count` on delete

### Client scan runner

`src/hooks/useScanRunner.ts`:
- Polls `/api/scan/progress` every 2s
- User-priority chunk queue; background continuation with throttle
- Stale-kick only when `updated_at` present and >3min old
- `canContinueScan` / partial-scan detection for dashboard CTAs
- Ignores `scan_jobs` rows with `action_type` set (not a scan)
- On complete: `router.refresh()`; auth expiry → `/?message=gmail_auth_expired`

`src/lib/scan/scanFetch.ts` — cache-bust `?n=` on scan POST/progress; `purgeScanServiceWorkers()` on scan start.

---

## Dashboard

**Server:** `loadUserSenders()` paginates all rows (no 1000-row cap), applies overrides, computes stats.

**Health score** (`src/lib/scoring.ts`) — **ratio-based** (scales with inbox size):
- Start 100; requires `totalEmails > 0`
- −90 × (junk emails / total emails)
- −25 × (unsure emails / total emails)
- +0.5 per unsubscribed sender (max +8)
- Unread penalties by % of inbox: >5% −4, >10% −8, >20% −12, >40% −18
- Sender sprawl: up to −10 if >30 junk senders AND junk senders >25% of all senders
- Labels: Healthy 80+ (green) / Cluttered 50–79 (amber) / Messy 20–49 (red) / Critical 0–19 (red pulse)

**Stat cards:** junk / unsure / safe **sender counts**; summary card = total **emails** from junk senders.

**Scan CTAs:**
- Scan My Inbox (full)
- Continue Scan (partial/cancelled/error with checkpoint)
- Sync New Emails (incremental via `gmail_history_id`)
- Rescan Inbox (full, wipes `user_senders`, keeps classification cache)
- Partial-scan banner + "Review Saved Senders"

**Components:** `HealthScoreCircle`, `StatCard`, `ErrorBoundary`

---

## Senders Page (`/dashboard/senders`)

**Data loading** (`src/lib/senders/loadUserSenders.ts`):
- Shared by dashboard, senders page, and `GET /api/senders`
- Paginate by stable `id`; sort by `email_count` desc for display
- Applies `user_sender_overrides` to classification

**Freshness (Stage 15):**
- Both pages `export const dynamic = 'force-dynamic'`
- `SenderList` fetches `GET /api/senders` on mount (bypasses stale RSC router cache)
- Dashboard links use `prefetch={false}`

**SenderList** (`src/components/SenderList.tsx`):
- Filter tabs: All / Junk / Unsure / Safe — counts match visible (actionable) rows
- "Cleaned" = `is_unsubscribed` OR `email_count===0`; hidden by default ("Show cleaned" toggle)
- **Pagination: 50 senders per page** (`SenderPagination.tsx`) — display only; selection/actions use full filter
- Select All = all senders in current filter (all pages); selections persist across pages
- Sticky `ActionBar` when selection exists; `ProgressModal` for action progress
- Sender override: hover (desktop) / long-press (mobile) Safe/Junk on `SenderCard`

**SenderCard:** avatar, name, email, `N emails · M unread`, classification dot, unsubscribe badge.

---

## Components (key)

| Component | Role |
|-----------|------|
| `SenderList` | Main review UI, reducer state, pagination, actions |
| `SenderCard` | Per-sender row |
| `SenderPagination` | Prev/Next, page indicator, range text |
| `FilterTabs` | Classification filter with counts |
| `ActionBar` | Delete / Mark Read / Archive / Unsub+Delete; 5s delete countdown |
| `ProgressModal` | Per-sender status, two-phase unsub, ETA, retry |
| `InstallPrompt` | Add to home screen (iOS/Android) |
| `LoadingSkeleton` | Route loading state |
| `ErrorBoundary` | Dashboard + senders error recovery |

---

## PWA & Service Worker

- `public/manifest.json` — charcoal theme, standalone, portrait
- Icons: `public/icons/icon-192.png`, `icon-512.png`, `icon.svg`
- `public/sw.js` — **clearity-v5**; cache-first static assets only; **never intercepts `/api/*`**; navigate = network-first with offline fallback
- `ServiceWorkerRegister` — unregisters legacy SWs + clears `clearity-*` caches before registering (fixes cached 500 scan POSTs)
- `scripts/generate-icons.mjs` — icon generation (sharp devDep)

---

## Environment Variables

Required in `.env.local` and Vercel:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB writes (scans, actions) |
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `GEMINI_API_KEY` | Gemini classification |
| `NEXT_PUBLIC_APP_URL` | App base URL (production domain) |
| `SCAN_WORKER_SECRET` | Bearer secret for `/api/scan/continue` — **required** for tab-closed scans |
| `CRON_SECRET` | Bearer for `/api/cron/resume-scans` — Vercel sends automatically when set |

**OAuth notes:**
- Google Cloud redirect URI = Supabase callback URL only (not app domain)
- Supabase Auth Site URL + redirect URLs = production domain
- Gmail API must be enabled on the OAuth project

---

## Deployment (Vercel)

1. Set all env vars above (especially `SCAN_WORKER_SECRET` + `CRON_SECRET`)
2. Apply `supabase/schema.sql` in Supabase SQL editor (Stage 11 migration required)
3. Google OAuth: production domain in authorized redirect URIs (via Supabase)
4. `vercel.json` cron: `/api/cron/resume-scans` daily (`0 0 * * *`) — Hobby plan limit; primary driver is `waitUntil` continuation chain
5. `next.config.ts` sets `x-vercel-skip-toolbar: 1` on all routes

---

## Utility Scripts

| Script | Purpose |
|--------|---------|
| `scripts/generate-icons.mjs` | Generate PWA icons |
| `scripts/verify-scan-logic.mjs` | Regression checks for scan state logic |
| `scripts/debug-scan-state.mjs` | Debug scan job state |

---

## Types

`src/types/index.ts` — `UserSender`, `ScanProgress`, `Classification`, `FilterValue`, `ClassificationResult`, `UnsubscribeStatus`, `QuotaExceededError`, `ScanCancelledError`

---

## Lib Map (quick reference)

```
src/lib/
├── gmail/          client, scanner, listMessages, bulkActions, unsubscribe,
│                   getMessageIds, processSenders, parseFrom, parseUnsubscribe,
│                   gmailErrors, handleTokenExpiry, incrementalScan
├── scan/           runScanChunk, chunkLock, scheduleContinuation, persistence,
│                   classifyPartial, scanState, scanErrors, scanFetch, actionGuard
├── classification/ classify, geminiClassifier, ruleBasedClassifier, features
├── senders/        loadUserSenders
├── supabase/       client, server, fetchAllRows
├── scoring.ts      calculateHealthScore (ratio-based)
├── utils.ts        cn, extractDomain, formatCount, chunk
└── api/            scanResponse
```

---

## Stage History (changelog)

### Stage 8 — PWA
Manifest, icons, service worker, install prompt, offline page, safe areas, desktop max-width.

### Stage 9 — Dashboard
Health score circle, stat cards, junk email total, settings page, rescan inline.

### Stage 10 — Polish & Reliability
ErrorBoundary, Gmail token expiry flow, re-scan clear, scan cancel, ETA, sender overrides UI, hide cleaned, unsubscribe-only, a11y, reduced motion, ProgressModal ETA.

### Stage 11 — Resumable & Background Scans
Chunked scans, `scan_message_ids`, background continuation, cron safety net, incremental sync, atomic chunk lock, adaptive throttle, continuation guard.

### Stage 12 — Production Hardening
Auth-expiry worker runaway fix, cron resumes errored scans, Supabase 1000-row pagination, classification skip bug fix, scan↔action mutual exclusion, ProgressModal stale-complete race, optimistic update fixes, listing dedupe, Gmail retry hardening, Gemini 2.5 Flash, lint clean.

### Stage 13 — Quota-Proof Checkpointing
500-message sub-slice checkpointing, deadline-aware quota backoff, listing-phase quota pause, 240s chunk budget.

### Stage 14 — Bulk-Action Scaling + Unsubscribe Reliability
`processSendersInterleaved`, HTTP-first unsubscribe, `parseMailto`, cleaned-sender filter fix.

### Stage 15 — Production Polish (current)
- **Dashboard ↔ senders data sync:** `loadUserSenders`, `GET /api/senders`, `force-dynamic`, client fresh fetch, `prefetch={false}`
- **Sender list pagination:** 50 per page (`SenderPagination`); actions unchanged
- **Ratio-based health score:** junk/unsure/unread scale with inbox volume
- **Scan/SW hardening:** SW v5 no API intercept; unregister legacy SWs; cache-bust scan fetches; recoverable scan errors return 200 (not cacheable 500); stale-kick only with `updated_at`; friendly quota messages; `saveScanProgress` throws on DB failure; cancel without `cancelled_at` column

---

## Known Limitations

- Partial-scan health score / stats reflect **scanned portion only**, not full Gmail inbox
- Bulk actions over very large selections may hit 240s budget — run again to finish (`status='complete'`, "Stopped early…")
- Bulk action while a parked partial scan exists can clobber scan resume position (senders kept; use Sync or full rescan)
- Clicking Scan within ~3s of Cancel may no-op once (lock releasing) — click again
- Intra-slice crash may re-process ≤500 messages (sub-slice checkpoint window)
- Sender override optimistic updates persist if POST fails until refresh
- ETA unreliable for first ~10% of scan or bulk action
- Gmail OAuth app unverified (100 external users until Google verification)
- Gmail only — no Outlook/Exchange
- Cron on Hobby is once/day — `waitUntil` chain is primary for background scans
- Same brand with multiple `From` addresses = multiple sender rows (by design)

---

## Future Work

- Google OAuth verification (privacy policy, brand assets, Google review)
- Payments / subscription gating
- Outlook support (Microsoft Graph API)
- Domain-level UI rollups (display only) for brands with many From addresses
- Toast notifications for override saves and scan cancellation
