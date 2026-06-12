import { extractDomain } from '@/lib/utils'

export interface ParsedFrom {
  name: string | null
  email: string
  domain: string
}

export function parseFrom(raw: string): ParsedFrom | null {
  try {
    const trimmed = raw.trim()

    // "Name <email>" or '"Name" <email>'
    const angleMatch = trimmed.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/)
    if (angleMatch) {
      const name = angleMatch[1].trim() || null
      const email = angleMatch[2].trim().toLowerCase()
      return { name, email, domain: extractDomain(email) }
    }

    // bare email
    if (trimmed.includes('@')) {
      const email = trimmed.toLowerCase()
      return { name: null, email, domain: extractDomain(email) }
    }

    return null
  } catch {
    return null
  }
}
