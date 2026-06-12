import { headers } from 'next/headers'

/** Request-aware app origin — avoids stale NEXT_PUBLIC_APP_URL after deploys. */
export async function getAppOrigin(): Promise<string> {
  const headersList = await headers()
  const host = headersList.get('x-forwarded-host') ?? headersList.get('host')

  if (host) {
    const proto =
      headersList.get('x-forwarded-proto') ??
      (host.startsWith('localhost') ? 'http' : 'https')
    return `${proto}://${host}`
  }

  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
}
