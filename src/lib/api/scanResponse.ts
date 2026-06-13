import { NextResponse } from 'next/server'

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
}

/** JSON for scan routes — never cache API responses in the browser or SW. */
export function scanJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_CACHE })
}
