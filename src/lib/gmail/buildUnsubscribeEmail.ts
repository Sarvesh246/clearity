export function buildUnsubscribeEmail(toAddress: string): string {
  const raw = [
    `To: ${toAddress}`,
    'From: me',
    'Subject: Unsubscribe',
    'Content-Type: text/plain',
    '',
    'Please unsubscribe me from this mailing list.',
  ].join('\r\n')

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
