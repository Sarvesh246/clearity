import { createClient } from '@/lib/supabase/server'

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
    throw new Error('Gmail not connected — please sign in again to reconnect')
  }

  return data.google_refresh_token
}
