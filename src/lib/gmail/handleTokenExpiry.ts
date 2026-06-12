export function isGoogleTokenExpiry(err: unknown): boolean {
  return (
    (err as { code?: number })?.code === 401 ||
    (err as { status?: number })?.status === 401 ||
    (err as { response?: { status?: number } })?.response?.status === 401 ||
    (err instanceof Error && (
      err.message.includes('invalid_grant') ||
      err.message.toLowerCase().includes('token has been expired')
    ))
  )
}
