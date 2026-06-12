import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * No stored refresh token (user signed out, revoked access, or token was
 * cleared after expiry). Retrying cannot help — the user must sign in again —
 * so callers must treat this like token expiry, never as a transient error.
 */
export class GmailNotConnectedError extends Error {
  constructor() {
    super('Gmail not connected — please sign in again to reconnect')
  }
}

export async function getRefreshTokenForUser(
  admin: SupabaseClient,
  userId: string
): Promise<string> {
  const { data, error } = await admin
    .from('profiles')
    .select('google_refresh_token')
    .eq('id', userId)
    .single()

  if (error || !data?.google_refresh_token) {
    throw new GmailNotConnectedError()
  }

  return data.google_refresh_token
}
