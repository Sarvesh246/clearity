export type Classification = 'junk' | 'safe' | 'unsure'

export type FilterValue = 'all' | 'junk' | 'unsure' | 'safe'

export interface UserSender {
  id: string
  user_id: string
  sender_email: string
  sender_name: string | null
  domain: string
  email_count: number
  unread_count: number
  has_unsubscribe_header: boolean
  unsubscribe_mailto: string | null
  unsubscribe_url: string | null
  unsubscribe_post: boolean
  gmail_labels: string[]
  classification: Classification | null
  classification_method: 'ai' | 'rule_based' | null
  is_unsubscribed: boolean
  last_scanned_at: string
}

export interface UnsubscribeStatus {
  success: boolean
  method: 'post' | 'mailto' | 'url_get' | 'none'
  error?: string
}

export interface ScanProgress {
  status: 'idle' | 'scanning' | 'complete' | 'error' | 'cancelled'
  phase: string
  scanned: number
  total: number
  list_complete?: boolean
  cursor?: number
  updated_at?: string | null
  action_type?: 'trash' | 'mark_read' | 'archive' | 'unsub_delete' | null
  processed?: number
  sender_statuses?: Record<string, 'queued' | 'in_progress' | 'done'>
  unsubscribe_statuses?: Record<string, UnsubscribeStatus>
}

export interface ClassificationResult {
  domain: string
  classification: Classification
  confidence: number
  method: 'ai' | 'rule_based'
  reason: string
}

export class QuotaExceededError extends Error {
  constructor() { super('Gemini quota exceeded') }
}

export class ScanCancelledError extends Error {
  constructor() { super('Scan cancelled by user') }
}
