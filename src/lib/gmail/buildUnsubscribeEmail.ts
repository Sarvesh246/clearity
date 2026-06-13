/**
 * A List-Unsubscribe mailto value can carry RFC 2369 / RFC 6068 query params,
 * e.g. `unsub@list.com?subject=unsubscribe&body=please`. Dropping the raw
 * string straight into the `To:` header produces an invalid recipient
 * (`unsub@list.com?subject=...`) and the message bounces. Split the address
 * from its headers and honour the sender's requested subject/body.
 */
export function parseMailto(rawMailto: string): { to: string; subject: string; body: string } {
  // Strip a leading `mailto:` scheme if it survived parsing.
  const cleaned = rawMailto.replace(/^mailto:/i, '').trim()
  const [addressPart, queryPart] = cleaned.split('?')
  const to = addressPart.trim()

  let subject = 'Unsubscribe'
  let body = 'Please unsubscribe me from this mailing list.'

  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    const qSubject = params.get('subject')
    const qBody = params.get('body')
    if (qSubject) subject = qSubject
    if (qBody) body = qBody
  }

  return { to, subject, body }
}

export function buildUnsubscribeEmail(rawMailto: string): string {
  const { to, subject, body } = parseMailto(rawMailto)

  // Omit From — Gmail's messages.send API sets it from the authenticated account.
  // An explicit "From: me" is RFC-invalid and causes strict SMTP servers (e.g.
  // customer.io) to close the connection mid-transfer ("closed pipe" / 554).
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n')

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
