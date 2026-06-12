import { createClient } from '@/lib/supabase/server'
import { GmailNotConnectedError } from './getRefreshTokenForUser'

export async function getRefreshToken(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) throw new Error('Not authenticated — please sign in')

  const { data, error } = await supabase
    .from('profiles')
    .select('google_refresh_token')
    .eq('id', user.id)
    .single()

  if (error || !data?.google_refresh_token) {
    throw new GmailNotConnectedError()
  }

  return data.google_refresh_token
}
