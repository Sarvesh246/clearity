# Clearity — Inbox Recovery Tool

## Status: Stage 10 Complete — Production Ready MVP

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

### Known limitations
- Scan cancellation does not save partial results (scan cleared user_senders at start; cancelled = empty state)
- Sender override optimistic updates persist if POST `/api/overrides` fails (silently, until page refresh)
- Estimated time is rate-based and unreliable for the first ~10% of a scan or bulk action
- Gmail OAuth app is unverified (100-user cap for external users until Google verification)
- Gmail only — no Outlook/Exchange support

### Future work
- Persist partial scan results on cancellation (requires intermediate DB upserts during scan)
- Google OAuth verification (requires Google review, privacy policy, brand assets)
- Payments / subscription gating
- Outlook support (Microsoft Graph API)
- Toast notifications for override saves and scan cancellation

### Deployment (Vercel)
- Set all env vars from `.env.local` in Vercel project settings
- Supabase: apply `supabase/schema.sql` manually in SQL editor
- Google OAuth: add production domain to Authorized Redirect URIs in Google Cloud Console
- PWA: icons in `public/icons/` are served statically — no build step needed
