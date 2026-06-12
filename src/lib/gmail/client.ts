import { google } from 'googleapis'

export function getGmailClient(refreshToken: string) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`
  )
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  return google.gmail({ version: 'v1', auth: oauth2Client })
}
