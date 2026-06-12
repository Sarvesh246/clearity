# Clearity — Inbox Recovery Tool

## Status: Stage 12 Complete — Production hardened (full-debug pass June 2026)

## Stack
- Next.js 16 App Router, TypeScript, Tailwind v4
- Supabase (auth + database)
- Gmail API + Gemini Flash API
- PWA (configured in Stage 8)

## Design System
- Neumorphism on charcoal base (#1a1a1e)
- Surface: #222228, shadows: light #2c2c35 / dark #111116
- Accents: red #e84141, green #26de81, amber #ffb142, blue #45aaf2, purple #a55eea
- Font: Space Grotesk (loaded via next/font/google)
- Tailwind v4: design tokens defined in `src/app/globals.css` via `@theme` block
- CSS classes: .neu-card, .neu-button, .neu-button:active, .neu-inset

## Tailwind v4 Note
This project uses Tailwind v4. There is NO tailwind.config.ts — all custom colors,
shadows, and font tokens are declared in `src/app/globals.css` under `@theme {}`.
Custom utility classes: `bg-base`, `bg-surface`, `text-accent-red`, `shadow-neu`, etc.

## Database Tables
- profiles (id, email, google_refresh_token, last_scan_at)
- sender_classifications (domain, classification, confidence, method, reason)
- user_senders (user_id, sender_email, sender_name, domain, email_count, unread_count, has_unsubscribe_header, unsubscribe_mailto, unsubscribe_url, unsubscribe_post, gmail_labels, classification, is_unsubscribed)
- user_sender_overrides (user_id, sender_email, override)
- scan_jobs (user_id, status, phase, scanned, total, started_at, completed_at, action_type, processed, sender_statuses)

Schema SQL: `supabase/schema.sql` — apply manually in Supabase SQL editor.

## What Exists
- Landing page (`src/app/page.tsx`) with "Sign in with Google" wired to server action
- Full Tailwind v4 design token system in globals.css
- Supabase browser client (`src/lib/supabase/client.ts`)
- Supabase server client (`src/lib/supabase/server.ts`)
- Auth proxy (`src/proxy.ts`) — redirects unauthenticated users from /dashboard and /scan to / (Next.js 16 renamed middleware → proxy)
- Utility functions: cn, extractDomain, formatCount (`src/lib/utils.ts`)
- Google OAuth flow (sign in → callback → profile upsert → /dashboard) (`src/app/actions/auth.ts`, `src/app/auth/callback/route.ts`)
- Refresh token stored in `profiles.google_refresh_token`
- Gmail API client helper — `getGmailClient` (`src/lib/gmail/client.ts`)
- Refresh token server helper — `getRefreshToken` (`src/lib/gmail/getRefreshToken.ts`)
- Sign out wired — clears token + session
- Dashboard at `/dashboard` — shows email, wired scan button with live progress UI (`src/app/dashboard/page.tsx`, `src/app/dashboard/DashboardClient.tsx`)
- Profile auto-creation DB trigger (SQL in comment at top of `src/app/auth/callback/route.ts` — run manually in Supabase)
- Full inbox scanner (metadata only, no bodies) — `src/lib/gmail/scanner.ts`
  - Groups emails by sender with email_count, unread_count, gmail_labels
  - Extracts List-Unsubscribe headers (mailto + url + RFC 8058 post flag)
  - Chunk-based processing (100/chunk, 2s delay) respects Gmail quota (15k units/min)
  - Exponential backoff on 429 errors
- From header parser — `src/lib/gmail/parseFrom.ts`
- List-Unsubscribe parser — `src/lib/gmail/parseUnsubscribe.ts`
- Scan API route — POST `/api/scan` runs full scan, upserts user_senders, updates last_scan_at
- Progress API route — GET `/api/scan/progress` returns current scan_jobs row
- Progress tracking via scan_jobs table + 2s client polling
- TypeScript types in `src/types/index.ts` (UserSender, ScanProgress, Classification, FilterValue, ClassificationResult, QuotaExceededError)
- Two-tier classification engine (Gemini Flash → rule-based fallback) — `src/lib/classification/`
  - Rule-based: explicit safe/junk domain lists (~150 domains) + signal scoring (List-Unsubscribe header, Gmail labels, frequency, name patterns)
  - AI: Gemini 1.5 Flash in batches of 20; `QuotaExceededError` causes silent fallback to rule-based for all remaining
  - Results cached in `sender_classifications` by domain (shared across users)
  - User overrides always win (`user_sender_overrides` table)
  - Classification auto-runs after scan completes (single request flow, phase: "Classifying senders...")
- Standalone classify endpoint — POST `/api/classify` re-classifies unclassified senders without re-scanning
- Full sender list UI at `/dashboard/senders` (`src/app/dashboard/senders/page.tsx`, `src/components/SenderList.tsx`)
  - SenderCard: checkbox, avatar, sender info, classification dot, unsubscribe badge (`src/components/SenderCard.tsx`)
  - FilterTabs: All / Junk / Unsure / Safe with counts, active tab uses neu-inset style (`src/components/FilterTabs.tsx`)
  - Select All / Deselect All for current filter view; count shows "N of M selected"
  - Selection state: selectedSenders (Set<string>), persists across tab switches (useReducer)
  - Sticky ActionBar: slides up via framer-motion when selection exists (`src/components/ActionBar.tsx`)
    - Buttons: Delete All (red), Mark Read (blue), Archive (amber), Unsubscribe+Delete (red, conditional)
    - Action buttons are stubs (Stage 7 wires them); hover shows accent color glow
  - Empty states: no senders, filter-empty, all-cleaned
  - Loading skeletons via route loading.tsx + LoadingSkeleton component (`src/components/LoadingSkeleton.tsx`)
- FilterValue type exported from `src/types/index.ts`

## Environment Variables Needed
Fill in `.env.local`:
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GEMINI_API_KEY
- NEXT_PUBLIC_APP_URL
- SCAN_WORKER_SECRET — REQUIRED for background scan continuation (tab-closed long scans). Shared bearer secret the app uses to call its own `/api/scan/continue` worker. Must match between the app and itself; set the SAME value in Vercel.
- CRON_SECRET — REQUIRED for the resume-scans cron safety net. Vercel auto-sends `Authorization: Bearer <CRON_SECRET>` to scheduled crons when this env var is set. Set in Vercel.

- Bulk actions: trash, mark read, archive — all working via Gmail API (`src/app/api/actions/route.ts`)
  - `getMessageIdsForSenders` — paginates messages.list per sender, max 5 concurrent (`src/lib/gmail/getMessageIds.ts`)
  - `trashMessages`, `markAsRead`, `archiveMessages` — batchModify in chunks of 1000, 429 retry (`src/lib/gmail/bulkActions.ts`)
  - Real-time progress via scan_jobs table (action_type, processed, sender_statuses JSONB), polled every 1.5s
  - ProgressModal: per-sender ✓/⏳/○ status, progress bar with accent colors, stall detection with cycling messages (`src/components/ProgressModal.tsx`)
  - ActionBar: 5-second countdown + draining bar before destructive delete; Mark Read/Archive fire immediately (`src/components/ActionBar.tsx`)
  - Post-action summary screen with email count, "Clean up more" / "Back to inbox"
  - Optimistic state updates: trashed senders removed from list, mark_read zeros unread_count — no refetch needed
  - Error handling: 429 retry with exponential backoff, error state with Retry button

- Smart unsubscribe engine — `src/lib/gmail/unsubscribe.ts`, `src/lib/gmail/buildUnsubscribeEmail.ts`
  - Three methods in priority order: RFC 8058 POST (`unsubscribe_post + unsubscribe_url`), mailto (`unsubscribe_mailto`), URL GET (`unsubscribe_url`)
  - Each method has 10s timeout via `AbortController`; failures never block email deletion
- Unsubscribe + Delete API route — POST `/api/unsubscribe`
  - Phase 1: Unsubscribes all senders that have `has_unsubscribe_header = true` (max 5 concurrent)
  - Phase 2: Trashes all emails from all selected senders (including those without unsubscribe headers)
  - Updates `user_senders.is_unsubscribed = true` for successful unsubscribes, zeros `email_count` for all
  - Tracks per-sender unsubscribe results in `scan_jobs.unsubscribe_statuses` JSONB
- Progress modal (`ProgressModal.tsx`) extended with two-phase unsubscribe+delete display
  - Phase 1: per-sender ✓/✗/— icons with method label (one-click / via email / via URL / no automatic method)
  - Phase 2: standard email-count progress bar (reuses Stage 6 UI)
  - Summary shows "Unsubscribed from X senders and deleted Y emails"
- SenderCard badge: green "✓ Unsubscribed" when `is_unsubscribed = true`; blue "✉ Unsubscribe available" otherwise
- ActionBar: shows note "X senders won't be auto-unsubscribed — emails will still be deleted" when mixed selection

- PWA manifest (`public/manifest.json`) with charcoal theme (#1a1a1e), standalone display, portrait orientation
- App icons (`public/icons/icon-192.png`, `icon-512.png`, `icon.svg`) — envelope + lightning bolt concept on charcoal bg
- Service worker (`public/sw.js`): cache-first for static assets, network-first for `/api/*`, offline fallback to `/offline`
- All iOS PWA meta tags via Next.js metadata/viewport exports in `src/app/layout.tsx` (apple-mobile-web-app-capable, status-bar-style: black-translucent, touch icon, manifest link)
- Safe area insets: nav bar top (`env(safe-area-inset-top)`) in senders page; ActionBar bottom already uses `max(12px, env(safe-area-inset-bottom))`
- Add to home screen prompt (`src/components/InstallPrompt.tsx`): iOS instructions (Share → Add to Home Screen), Android native `beforeinstallprompt` flow; dismisses for 7 days
- Desktop max-width layout: senders page content capped at 672px centered; ActionBar inner card also constrained
- FilterTabs tap targets bumped to 44px height
- Offline fallback page at `/offline` (`src/app/offline/page.tsx`) — matches app design
- ServiceWorkerRegister client component (`src/components/ServiceWorkerRegister.tsx`) — registers `sw.js` on mount
- Icon generation script: `scripts/generate-icons.mjs` (uses sharp devDep)

- Full dashboard at `/dashboard`: health score circle, stat cards (junk/unsure/safe), junk email total, primary CTA to senders (`src/app/dashboard/page.tsx`, `src/app/dashboard/DashboardContent.tsx`)
- Health score: 0-100 formula in `src/lib/scoring.ts` — deducts for junk (-2) and unsure (-1) senders, adds for unsubscribed (+1), extra deductions for high unread or >50 junk senders
- Score labels: Healthy (green, 80-100) / Cluttered (amber, 50-79) / Messy (red, 20-49) / Critical (red + pulse, 0-19)
- Score circle SVG animation on mount, draws from 0 to score — `src/components/HealthScoreCircle.tsx`
- StatCard component — reusable neu-card with icon, colored value, label (`src/components/StatCard.tsx`)
- No-scan placeholder state: "?" circle, dashes in stats, "Scan My Inbox" as primary CTA
- Rescan flow inline on dashboard: progress bar + phase text, on complete calls `router.refresh()` to reload server data
- Settings page at `/dashboard/settings`: email display, back to dashboard link, sign out (`src/app/dashboard/settings/page.tsx`)
- Gear icon in dashboard header links to settings; back arrow in settings returns to dashboard

## Stage 10 — Polish & Reliability

### Added in Stage 10
- ErrorBoundary: Class component (`src/components/ErrorBoundary.tsx`) wrapping dashboard and senders page; neumorphic "Something went wrong" card with retry button
- Gmail token expiry: API routes (scan, actions, unsubscribe) detect Google 401/invalid_grant, clear `google_refresh_token` from profiles, return structured 401; DashboardContent redirects to `/?message=gmail_auth_expired`; landing page shows error banner when param present; shared helper `src/lib/gmail/handleTokenExpiry.ts`
- Re-scan clear: `scan/route.ts` DELETEs user_senders before starting new scan; `sender_classifications` cache preserved (AI results reused)
- Scan cancellation: POST `/api/scan/cancel` sets scan_jobs status to 'cancelled'; scanner.ts accepts AbortSignal and throws ScanCancelledError; scan/route.ts polls DB every 3s and aborts; DashboardContent shows Cancel button and handles 'cancelled' status in poll
- Estimated scan time: scanner.ts calculates rate-based ETA and includes it in onProgress phase text after first chunk
- Sender overrides UI: SenderCard shows hover overlay (desktop) and long-press overlay (mobile) with Safe/Junk buttons; dispatches to POST `/api/overrides`; override badge shown on card; override state managed in SenderList reducer
- Hide cleaned toggle: SenderList filters out email_count=0 senders by default; "Show cleaned" / "Hide cleaned" toggle button in toolbar
- Unsubscribe Only: ActionBar overflow ⋯ menu with "Unsubscribe Only" option (shown when unsubscribable senders selected); POST `/api/unsubscribe` accepts `deleteAfter: false` to skip Phase 2
- Accessibility: FilterTabs `role="tablist"`/`role="tab"`/`aria-selected`; LoadingSkeleton `role="status"`/`aria-busy`/sr-only text; SenderCard checkbox `role="checkbox"`/`aria-checked`/`tabIndex`/keyboard nav; ProgressModal `role="dialog"`/`aria-modal`/`aria-live` on progress text; Escape key closes modal; focus-visible ring in globals.css
- Reduced motion: `@media (prefers-reduced-motion: reduce)` block in globals.css disables all transitions
- ETA in ProgressModal: rate-based estimated time remaining shown for bulk actions after 100+ processed
- Checkbox micro-animation: scale pulse on toggle via Framer Motion

## Stage 11 — Resumable & Background Scans (200k+ inboxes)

### Architecture
- Listing and reading are split into time-boxed chunks. Each Vercel invocation runs ~270s (`CHUNK_TIME_BUDGET_MS`), then schedules the next chunk server-side via `waitUntil` → `POST /api/scan/continue` (`src/lib/scan/scheduleContinuation.ts`). Scans continue with the tab closed.
- Message IDs persist in `scan_message_ids` (one row per ID); progress/cursor/page-token persist in `scan_jobs`. Senders are upserted and classified per chunk, so partial results are always saved and reviewable.
- Cron safety net `*/2` (`/api/cron/resume-scans`, `vercel.json`) re-kicks scans that stalled (worker timeout, network drop). NOTE: Vercel Hobby caps crons at once/day — the `waitUntil` chain is the primary driver and works on any plan; the cron is backup.
- Incremental sync: after a full scan, `gmail_history_id` is stored; "Sync New Emails" uses `history.list` to fetch only new messages.

### Reliability fixes (rate limits + start/stop correctness)
- **Atomic chunk lock** (`src/lib/scan/chunkLock.ts`): single compare-and-swap UPDATE (`chunk_locked_at IS NULL OR < stale`) guarantees only one chunk runs per user. The previous check-then-update was racy and let two workers run concurrently → doubled Gmail request rate → 429s. The lock no longer gates on `status='scanning'`, so fresh starts/rescans after complete/cancel/idle actually run (previously silently `skipped`).
- **Adaptive throttle** (`src/lib/gmail/scanner.ts`): paces `messages.get` against Gmail's real limit (250 quota units/user/sec; get = 5 units). Starts ~24 msg/s (~120 units/s), ramps to 40, halves on any 429/rate signal, then re-ramps — stays just below the ceiling. Replaces the old fixed 12s/batch delay (~92 msg/min → 200k took ~36h; now ~2–3h).
- **Transient resilience**: 404/410 (message deleted/moved mid-scan) are skipped, not fatal; 5xx retried with backoff. Prevents long scans crashing near the end.
- **Continuation guard** (`runScanChunk` `continuation` flag): background workers only RESUME in-progress scans — never start a fresh/incremental one. Stops a stray continuation (fired just before a cancel) from wiping `user_senders` and restarting a full rescan.

### Stage 11 known limitations
- Requires `SCAN_WORKER_SECRET` + `CRON_SECRET` env vars (app + Vercel) and the Stage 11 SQL migration applied; without the worker secret, scans stall when the tab closes.
- Clicking "Scan" within ~3s of "Cancel" can no-op once (old chunk still releasing the lock) — click again; it self-heals.
- Intra-slice crash re-scans up to one slice (~7k msgs); upserts are idempotent so no data corruption.

## Stage 12 — Production hardening (full-debug pass)

### Fixed
- **Auth-expiry worker runaway**: a revoked/missing refresh token mid-scan made `/api/scan/continue` reschedule itself forever (infinite Vercel invocations). Missing token is now a typed `GmailNotConnectedError` (`src/lib/gmail/getRefreshTokenForUser.ts`) treated as auth expiry; continue route never reschedules `gmail_auth_expired`; plain chunk errors reschedule with a 30s delay (`scheduleScanContinuation(..., { delayMs })`) so persistent failures back off.
- **Cron resumes errored scans**: `/api/cron/resume-scans` now matches status `scanning` OR `error` (skipping phase `Gmail access expired`) — previously an errored chain whose delayed retry died stranded the scan despite the UI promising auto-resume.
- **Supabase 1000-row cap**: senders page, dashboard counts/health score, `finalizePartialScan`, classify-cache lookups and overrides all paginate now (`src/lib/supabase/fetchAllRows.ts`); `classify.ts` chunks `.in()` queries (URL-length + row cap). All pagination uses explicit ORDER BY (range without order is non-deterministic).
- **Classification skip bug**: `classifyUnclassifiedSenders` advanced its offset while the `classification IS NULL` result set shrank — every other page of senders was skipped (left unclassified). Now always re-reads page 0 until empty.
- **Scan ↔ bulk-action mutual exclusion** (`src/lib/scan/actionGuard.ts`): actions and scans share the `scan_jobs` row + Gmail rate budget. `/api/actions` and `/api/unsubscribe` now 409 (`scan_running`/`busy`) while a live scan runs, hold the chunk lock with a 60s heartbeat for their whole duration, and release in `finally`. `useScanRunner` treats rows with `action_type` set as "not a scan" (no phantom scan UI).
- **`maxDuration = 300`** on `/api/actions` and `/api/unsubscribe` (they previously ran under the default and could be killed mid-delete).
- **ProgressModal stale-complete race**: the modal polled the shared `scan_jobs` row and could see a previous run's `complete` instantly → false "Done" + optimistic sender removal before the action even started. Now: terminal statuses are only honored after the action was observed running; the action POST response is the authoritative completion/error signal (`serverResult`/`serverError` props); 20s watchdog catches never-started actions; Retry actually re-POSTs; modal remounts per action (key prop). Also fixed: summary screen was unreachable (modal unmounted on completion).
- **Optimistic update mismatches**: `unsub_only` no longer zeroes email counts client-side (server keeps them); `unsub_delete` now zeroes counts for non-unsubscribable senders too (server deletes their emails).
- **Listing-resume duplicate IDs**: resuming the listing phase from a persisted page token dedupes the first re-listed chunk against stored `scan_message_ids` (a crash between insert and token-save previously double-stored and double-scanned those messages).
- **Gmail retry hardening** (`src/lib/gmail/gmailErrors.ts`): shared 429/403-rate/5xx/network-error classification; `withGmailRetry` on batchModify, per-sender `messages.list` (also quoted `from:"..."` queries), scan listing, and history.list; scanner treats dropped connections (ECONNRESET etc.) as transient.
- **Gemini model**: `gemini-1.5-flash` is retired (every call 404'd → silent rule-based fallback); now `gemini-2.5-flash`, with quota detection also via message text (`RESOURCE_EXHAUSTED`).
- Lint is fully clean (`npm run lint` → 0 problems): ActionBar countdown rewritten as a handler-driven interval (no setState-in-effect, no double-fire), ProgressModal ETA/stall state moved out of render, InstallPrompt defers its mount setState.

### Stage 12 known limitations
- A bulk action over very many emails (≫100k) can exceed the 300s budget; the killed run leaves `scan_jobs` stuck `scanning` until the next scan/action overwrites it (chunk lock self-heals via 6-min staleness; the modal must be dismissed manually).
- Running a bulk action while a *partial/errored* scan is parked clobbers the scan's resume position (total/scanned reset) — senders/data are kept, but "Continue Scan" disappears; use Sync New Emails or a fresh scan after.

### Known limitations
- Cancelling a scan now SAVES partial results (senders scanned so far are classified and kept); the empty-state cancel was fixed in Stage 11.
- Sender override optimistic updates persist if POST `/api/overrides` fails (silently, until page refresh)
- Estimated time is rate-based and unreliable for the first ~10% of a scan or bulk action
- Gmail OAuth app is unverified (100-user cap for external users until Google verification)
- Gmail only — no Outlook/Exchange support

### Future work
- Google OAuth verification (requires Google review, privacy policy, brand assets)
- Payments / subscription gating
- Outlook support (Microsoft Graph API)
- Toast notifications for override saves and scan cancellation

### Deployment (Vercel)
- Set all env vars from `.env.local` in Vercel project settings — including `SCAN_WORKER_SECRET` and `CRON_SECRET` (background scans stall without them)
- Supabase: apply `supabase/schema.sql` manually in SQL editor — the Stage 11 migration (scan_message_ids table, scan_jobs cursor/list_page_token/list_complete/chunk_locked_at/updated_at, profiles.gmail_history_id) is REQUIRED for resumable scans
- Google OAuth: add production domain to Authorized Redirect URIs in Google Cloud Console
- PWA: icons in `public/icons/` are served statically — no build step needed
