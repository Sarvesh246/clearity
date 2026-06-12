'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function signInWithGoogle() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: 'https://www.googleapis.com/auth/gmail.modify',
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      queryParams: {
        access_type: 'offline', // gets refresh token
        prompt: 'consent',      // forces refresh token on every sign-in
      },
    },
  })
  if (error) throw error
  if (data.url) redirect(data.url)
}

export async function signOut() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    await supabase
      .from('profiles')
      .update({ google_refresh_token: null })
      .eq('id', user.id)
  }
  await supabase.auth.signOut()
  redirect('/')
}
