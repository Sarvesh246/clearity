import type { SupabaseClient } from '@supabase/supabase-js'

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
    throw new Error('Gmail not connected — please sign in again to reconnect')
  }

  return data.google_refresh_token
}
