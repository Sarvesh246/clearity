-- ============================================================
-- Clearity — Database Schema
-- Apply this in the Supabase SQL editor
-- ============================================================

-- profiles: extends auth.users
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  google_refresh_token TEXT,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- shared classification cache across all users
CREATE TABLE public.sender_classifications (
  domain TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK (classification IN ('junk', 'safe', 'unsure')),
  confidence FLOAT,
  method TEXT CHECK (method IN ('ai', 'rule_based')),
  reason TEXT,
  classified_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- per-user sender scan results
CREATE TABLE public.user_senders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  domain TEXT,
  email_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  has_unsubscribe_header BOOLEAN DEFAULT FALSE,
  unsubscribe_mailto TEXT,
  unsubscribe_url TEXT,
  unsubscribe_post BOOLEAN DEFAULT FALSE,
  gmail_labels TEXT[],
  classification TEXT CHECK (classification IN ('junk', 'safe', 'unsure')),
  classification_method TEXT,
  is_unsubscribed BOOLEAN DEFAULT FALSE,
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, sender_email)
);

-- user overrides: manual safe/junk markings
CREATE TABLE public.user_sender_overrides (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_email TEXT NOT NULL,
  override TEXT NOT NULL CHECK (override IN ('safe', 'junk')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, sender_email)
);

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access own profile"
  ON public.profiles FOR ALL
  USING (auth.uid() = id);

ALTER TABLE public.user_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access own senders"
  ON public.user_senders FOR ALL
  USING (auth.uid() = user_id);

ALTER TABLE public.user_sender_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access own overrides"
  ON public.user_sender_overrides FOR ALL
  USING (auth.uid() = user_id);

ALTER TABLE public.sender_classifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read classifications"
  ON public.sender_classifications FOR SELECT
  USING (auth.role() = 'authenticated');
CREATE POLICY "Service role can write classifications"
  ON public.sender_classifications FOR ALL
  USING (auth.role() = 'service_role');

-- scan progress tracking (one row per user, upserted by service role during scan)
CREATE TABLE public.scan_jobs (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  status TEXT DEFAULT 'idle',
  phase TEXT,
  scanned INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.scan_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access own scan job"
  ON public.scan_jobs FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================
-- Stage 6 Migration: Bulk Actions
-- Run these ALTER statements in the Supabase SQL editor
-- ============================================================
ALTER TABLE public.scan_jobs
  ADD COLUMN IF NOT EXISTS action_type TEXT,
  ADD COLUMN IF NOT EXISTS processed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sender_statuses JSONB DEFAULT '{}'::jsonb;

-- ============================================================
-- Stage 7 Migration: Smart Unsubscribe
-- Run these ALTER statements in the Supabase SQL editor
-- ============================================================
ALTER TABLE public.scan_jobs
  ADD COLUMN IF NOT EXISTS unsubscribe_statuses JSONB DEFAULT '{}'::jsonb;

-- ============================================================
-- Stage 11 Migration: Resumable chunked scans (200k+ inboxes)
-- Run in the Supabase SQL editor
-- ============================================================
ALTER TABLE public.scan_jobs
  ADD COLUMN IF NOT EXISTS cursor INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS list_page_token TEXT,
  ADD COLUMN IF NOT EXISTS list_complete BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chunk_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
-- Note: cancel state is tracked via status='cancelled' + completed_at; no
-- dedicated cancelled_at column is required.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gmail_history_id TEXT;

-- Stores message IDs in rows (avoids multi-MB JSONB for 200k emails)
CREATE TABLE IF NOT EXISTS public.scan_message_ids (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (user_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_scan_message_ids_user
  ON public.scan_message_ids(user_id, idx);

ALTER TABLE public.scan_message_ids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access own scan message ids"
  ON public.scan_message_ids FOR ALL
  USING (auth.uid() = user_id);
