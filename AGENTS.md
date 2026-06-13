## Learned User Preferences

- Push completed significant work to master/main on GitHub when asked
- Cancel must truly stop scans; partial results must stay usable for review and bulk actions
- Scan/resume/cancel flows must be reliable at very large inbox scale (target ~200k emails)
- Scans should continue in the background when the browser tab closes or the device sleeps
- Mobile UI must be polished: consistent spacing, safe-area insets, and no header text cutoff (e.g. "Hey {name}")

## Learned Workspace Facts

- Production deployment URL is https://clearitymail.vercel.app
- Supabase Auth Site URL and redirect URLs must use the production domain, not localhost
- Google OAuth redirect URI in Cloud Console is only the Supabase callback URL, not the app domain
- Gmail API must be enabled in the Google Cloud project tied to GOOGLE_CLIENT_ID
- Resumable scans persist state in Supabase (scan_jobs, scan_message_ids, user_senders)
- Background scan continuation requires SCAN_WORKER_SECRET and CRON_SECRET configured on Vercel
- Incremental sync uses profiles.gmail_history_id after a full scan completes
