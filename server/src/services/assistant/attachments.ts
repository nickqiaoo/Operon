import type { AssistantAttachment } from '../../../../shared/assistant.js'
import { attachmentUrlFor, getAttachment, parseAttachmentUrl, putDataUrl } from '../attachment-store.js'

const MAX_ATTACHMENTS = 10
/** A text file longer than this reaches the model cut short. */
const TEXT_INLINE_LIMIT = 100_000

const TEXT_MEDIA = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|sql))/
const TEXT_EXTENSIONS =
  /\.(txt|md|csv|json|xml|ya?ml|html|css|js|ts|jsx|tsx|py|java|go|rs|c|cpp|h|sh|sql|log|env|toml|ini|cfg)$/i

/**
 * What the composer sent, made safe to keep: entries pointing into the attachment store pass, a
 * `data:` URL (the composer's fallback when its upload failed) is stored first, anything else is
 * dropped.
 */
export function normalizeAttachments(raw: unknown): AssistantAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: AssistantAttachment[] = []
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue
    const { url, filename } = item as { url?: unknown; filename?: unknown }
    if (typeof url !== 'string') continue
    const name = typeof filename === 'string' && filename ? filename : undefined
    let hash = parseAttachmentUrl(url)
    if (!hash && url.startsWith('data:')) hash = putDataUrl(url, name)?.hash ?? null
    const stored = hash ? getAttachment(hash) : undefined
    if (!hash || !stored) continue
    out.push({ url: attachmentUrlFor(hash), mediaType: stored.meta.mediaType, ...(name ? { filename: name } : {}) })
  }
  return out
}

function isText(attachment: AssistantAttachment): boolean {
  return TEXT_MEDIA.test(attachment.mediaType) || TEXT_EXTENSIONS.test(attachment.filename ?? '')
}

/**
 * The message as the main agent gets it: images as image content (the model sees them), text
 * files inlined, anything else named so the agent at least knows it was there — the same split
 * chats make (message-utils.ts normalizeUiMessagesFileAttachments).
 */
export function buildUserInput(text: string, attachments: readonly AssistantAttachment[]): { text: string; images: Array<{ data: string; mediaType: string }> } {
  const images: Array<{ data: string; mediaType: string }> = []
  const notes: string[] = []
  for (const attachment of attachments) {
    const name = attachment.filename ?? 'attachment'
    const hash = parseAttachmentUrl(attachment.url)
    const stored = hash ? getAttachment(hash) : undefined
    if (!stored) {
      notes.push(`[Attachment unavailable: ${name}]`)
    } else if (attachment.mediaType.startsWith('image/')) {
      images.push({ data: stored.data.toString('base64'), mediaType: stored.meta.mediaType })
    } else if (isText(attachment)) {
      const content = stored.data.toString('utf8')
      const clipped = content.length > TEXT_INLINE_LIMIT ? `${content.slice(0, TEXT_INLINE_LIMIT)}\n… (truncated)` : content
      notes.push(`<attachment name="${name}">\n${clipped}\n</attachment>`)
    } else {
      notes.push(`[File attached: ${name} (${attachment.mediaType}); its content is not readable here]`)
    }
  }
  return { text: [text, ...notes].filter(Boolean).join('\n\n'), images }
}

/** How a message's attachments read in a plain-text transcript. */
export function attachmentLabel(attachments: readonly AssistantAttachment[] | undefined): string {
  if (!attachments?.length) return ''
  return `[attached: ${attachments.map((a) => a.filename ?? a.mediaType).join(', ')}]`
}
