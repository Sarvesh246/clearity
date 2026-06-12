export interface ParsedUnsubscribe {
  mailto: string | null
  url: string | null
}

export function parseUnsubscribe(raw: string): ParsedUnsubscribe {
  try {
    const mailto = raw.match(/<mailto:([^>]+)>/i)?.[1] ?? null
    const url = raw.match(/<(https?:\/\/[^>]+)>/i)?.[1] ?? null
    return { mailto, url }
  } catch {
    return { mailto: null, url: null }
  }
}
