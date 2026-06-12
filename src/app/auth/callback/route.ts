/*
 * MANUAL SETUP REQUIRED — run this SQL once in the Supabase SQL editor:
 *
 * CREATE OR REPLACE FUNCTION public.handle_new_user()
 * RETURNS trigger AS $$
 * BEGIN
 *   INSERT INTO public.profiles (id, email)
 *   VALUES (new.id, new.email)
 *   ON CONFLICT (id) DO NOTHING;
 *   RETURN new;
 * END;
 * $$ LANGUAGE plpgsql SECURITY DEFINER;
 *
 * CREATE TRIGGER on_auth_user_created
 *   AFTER INSERT ON auth.users
 *   FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
 */

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) return NextResponse.redirect(`${origin}/?error=no_code`)

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`)
  }

  const { session } = data
  const refreshToken = session.provider_refresh_token

  // Upsert profile — create on first login, update token on return.
  // Only write refresh token if present: Google omits it on subsequent logins
  // unless prompt=consent is set, so we avoid overwriting a good token with null.
  await supabase.from('profiles').upsert(
    {
      id: session.user.id,
      email: session.user.email,
      ...(refreshToken ? { google_refresh_token: refreshToken } : {}),
    },
    { onConflict: 'id' }
  )

  return NextResponse.redirect(`${origin}/dashboard`)
}
