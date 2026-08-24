import { getChatHistoryService } from './state.js'
import {
  requestHostElicitation,
  type HostElicitationRequest,
  type HostElicitationResult,
} from './host-approval-broker.js'

const ORIGIN_ALIASES: Record<string, string[]> = {
  'bilibili.com': ['b站', '哔哩哔哩'],
  'youtube.com': ['油管'],
  'twitter.com': ['推特'],
  'x.com': ['twitter', '推特'],
  'weibo.com': ['微博'],
  'zhihu.com': ['知乎'],
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

function messageText(message: unknown): string {
  const record = asRecord(message)
  if (!record) return ''
  if (typeof record.content === 'string') return record.content
  if (!Array.isArray(record.parts)) return ''
  return record.parts
    .map((part) => {
      const partRecord = asRecord(part)
      return partRecord?.type === 'text' && typeof partRecord.text === 'string'
        ? partRecord.text
        : ''
    })
    .filter(Boolean)
    .join('\n')
}

function latestUserText(chatId: number): string {
  const messages = getChatHistoryService()?.getChat(chatId).messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index])
    if (message?.role !== 'user') continue
    return messageText(message)
  }
  return ''
}

function originTerms(origin: URL): string[] {
  const hostname = origin.hostname.toLowerCase().replace(/^www\./u, '')
  const labels = hostname.split('.').filter(Boolean)
  const terms = new Set<string>([origin.origin.toLowerCase(), hostname])
  const brand = labels[0]
  if (brand && brand.length >= 3) terms.add(brand)

  for (const [domain, aliases] of Object.entries(ORIGIN_ALIASES)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      for (const alias of aliases) terms.add(alias)
    }
  }
  return [...terms]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function explicitlyRejectsOrigin(userText: string, terms: string[]): boolean {
  return terms.some((term) => {
    const site = escapeRegExp(term)
    const chineseBefore = new RegExp(
      `(?:不要|别|禁止|不得|不允许|不可|避免)(?:访问|打开|使用|去|上)?\\s*${site}`,
      'iu',
    )
    const chineseAfter = new RegExp(
      `${site}.{0,8}(?:不要|别|禁止|不得|不允许|不可|避免)`,
      'iu',
    )
    const englishBefore = new RegExp(
      `(?:do\\s+not|don't|never|avoid)\\s+(?:(?:visit|open|use|access)\\s+)?${site}`,
      'iu',
    )
    const englishAfter = new RegExp(
      `${site}.{0,24}(?:should\\s+not|must\\s+not|do\\s+not|don't|never)`,
      'iu',
    )
    return [chineseBefore, chineseAfter, englishBefore, englishAfter]
      .some((pattern) => pattern.test(userText))
  })
}

/**
 * Conservative equivalent of Codex's host-side auto reviewer.
 *
 * Only a plain origin-access request can be auto-approved, and only when the
 * latest user-authored prompt explicitly names that origin/site. Uploads,
 * history, full CDP, sensitive data and every other permission always go to UI.
 */
export function shouldAutoReviewBrowserOrigin(
  request: HostElicitationRequest,
  userText: string,
): boolean {
  const meta = asRecord(request.meta)
  if (meta?.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string') return false
  if (
    meta.file_transfer !== undefined ||
    meta.sensitive_data !== undefined ||
    meta.full_cdp_access === true ||
    meta.riskLevel === 'high'
  ) {
    return false
  }

  let origin: URL
  try {
    origin = new URL(meta.origin)
  } catch {
    return false
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false

  const normalizedText = userText.trim().toLowerCase()
  if (!normalizedText) return false
  const terms = originTerms(origin)
  if (explicitlyRejectsOrigin(normalizedText, terms)) return false
  return terms.some((term) => normalizedText.includes(term))
}

export function requestOperonElicitation(
  chatId: number,
  request: HostElicitationRequest,
): Promise<HostElicitationResult> {
  if (shouldAutoReviewBrowserOrigin(request, latestUserText(chatId))) {
    return Promise.resolve({
      action: 'accept',
      _meta: { approvals_reviewer: 'auto_review' },
    })
  }
  return requestHostElicitation(chatId, request)
}
