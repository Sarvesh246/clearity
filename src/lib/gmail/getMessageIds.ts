import { gmail_v1 } from 'googleapis'
import { withGmailRetry } from './bulkActions'

export interface SenderMessageIds {
  email: string
  ids: string[]
}

async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let index = 0

  async function runNext(): Promise<void> {
    const current = index++
    if (current >= tasks.length) return
    results[current] = await tasks[current]()
    await runNext()
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, runNext)
  await Promise.all(workers)
  return results
}

export async function getMessageIdsForSender(
  gmail: gmail_v1.Gmail,
  senderEmail: string
): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  // Quote the address so characters Gmail search treats as operators
  // (spaces, parens) can't change the query's meaning.
  const query = `from:"${senderEmail.replace(/"/g, '')}"`

  do {
    const res = await withGmailRetry(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 500,
        pageToken,
      })
    )
    const messages = res.data.messages ?? []
    for (const m of messages) {
      if (m.id) ids.push(m.id)
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  return ids
}

export async function getMessageIdsForSenders(
  gmail: gmail_v1.Gmail,
  senderEmails: string[],
  onSenderStart?: (email: string) => void
): Promise<{ allIds: string[]; perSender: SenderMessageIds[] }> {
  const tasks = senderEmails.map(email => async () => {
    onSenderStart?.(email)
    const ids = await getMessageIdsForSender(gmail, email)
    return { email, ids }
  })

  const perSender = await withConcurrencyLimit(tasks, 5)

  const seen = new Set<string>()
  const allIds: string[] = []
  for (const { ids } of perSender) {
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        allIds.push(id)
      }
    }
  }

  return { allIds, perSender }
}
