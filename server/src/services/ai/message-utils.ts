import type { ModelMessage, UIMessage } from 'ai'
import type { FileMessagePartWithContent } from './types.js'
import { getAttachment, parseAttachmentUrl } from '../attachment-store.js'

/**
 * Merge consecutive same-role messages into a single message. Needed because
 * buildCompactAwareView prepends a synthetic user turn (rewritten from the
 * compact summary assistant) whose neighbor may also be a user message —
 * OpenAI-compatible providers reject u/u sequences.
 */
export function mergeConsecutiveSameRole(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length < 2) return messages

  const result: ModelMessage[] = []
  for (const current of messages) {
    const prev = result[result.length - 1]
    const mergeable =
      prev !== undefined &&
      prev.role === current.role &&
      (current.role === 'user' || current.role === 'assistant')

    if (!mergeable) {
      result.push(current)
      continue
    }

    const toArray = (content: unknown): unknown[] =>
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? content
          : []

    const merged = {
      ...prev,
      content: [...toArray(prev.content), ...toArray(current.content)],
    } as ModelMessage
    result[result.length - 1] = merged
  }
  return result
}

// ---- File attachment normalization ----

const extractAttachmentPathHint = (url: string, filename: string): string => {
  if (url.startsWith('file://')) {
    try {
      return decodeURIComponent(url.replace(/^file:\/\//, ''))
    } catch {
      return filename
    }
  }

  // A content-addressed URL is meaningless to the agent as a path — the hash
  // says nothing about what the file is. Fall back to the name the user saw.
  if (parseAttachmentUrl(url)) return filename
  if (url.startsWith('/')) return url
  if (url.startsWith('data:')) return filename
  return url || filename
}

const getAttachmentTextContent = (part: FileMessagePartWithContent): string => {
  if (typeof part.content === 'string' && part.content.length > 0) {
    return part.content
  }

  const filename = part.filename ?? 'attachment'
  const pathHint = extractAttachmentPathHint(part.url, filename)
  return `[File Attachment] ${pathHint}`
}

/**
 * Append a `<system-reminder>` block to the latest user message — per-turn
 * contextual guidance (reminder semantics), NOT a system prompt. Riding on the
 * user turn means every provider forwards it each turn, including the stateful
 * ones that only send the newest user message. Returns a new array with a
 * copied message; the originals are untouched (persistence holds references).
 */
export function appendTurnReminder(messages: UIMessage[], reminder: string): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user' || !Array.isArray(message.parts)) continue
    const updated: UIMessage = {
      ...message,
      parts: [...message.parts, { type: 'text', text: `\n\n<system-reminder>\n${reminder}\n</system-reminder>` }],
    }
    return [...messages.slice(0, i), updated, ...messages.slice(i + 1)]
  }
  return messages
}

/**
 * Concatenate every text part of an assistant `UIMessage` into a single string.
 * Used by callers that only need the model's final text after the turn is
 * assembled (git commit message, workflow subagent result, …).
 */
export function extractAssistantText(message: UIMessage): string {
  let text = ''
  for (const part of message.parts ?? []) {
    if (part.type === 'text') text += part.text
  }
  return text.trim()
}

/** Base64 with no URL scheme in front — too long and too plain to be anything else. */
const isBareBase64 = (url: string): boolean =>
  url.length >= 64 && !/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[A-Za-z0-9+/=\s]+$/.test(url)

export const normalizeUiMessagesFileAttachments = (messages: UIMessage[]): UIMessage[] =>
  messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.parts)) return message
    const normalizedParts = message.parts.flatMap((part): typeof message.parts => {
      if (part.type !== 'file') return [part]
      // Keep images — models need to see image content directly. They go to
      // the model as a `data:` URL: ai@7's convertToModelMessages runs every
      // file part's url through `new URL()`, so bare base64 throws "Invalid
      // URL", and a `data:` URL is inlined by the SDK rather than fetched.
      if (part.mediaType.startsWith('image/')) {
        // Content-addressed attachment: the transcript only carries a URL, so
        // read the bytes back off disk. Model APIs take base64 image content —
        // that encoding is unavoidable here; what the store buys is that the
        // DB, the history response and the browser no longer each hold a copy.
        const hash = parseAttachmentUrl(part.url)
        if (hash) {
          const stored = getAttachment(hash)
          if (stored) {
            const mediaType = stored.meta.mediaType
            return [{ ...part, url: `data:${mediaType};base64,${stored.data.toString('base64')}`, mediaType }]
          }
          // Blob is gone (store cleared, transcript copied between machines).
          // Drop to a text note so the turn still sends instead of the provider
          // rejecting an unfetchable URL.
          return [{ type: 'text' as const, text: `[Image attachment unavailable: ${part.filename ?? hash}]` }]
        }
        // Older transcripts persisted the stripped form (bare base64); give it
        // its scheme back so it parses as a URL.
        if (isBareBase64(part.url)) {
          return [{ ...part, url: `data:${part.mediaType};base64,${part.url.replace(/\s+/g, '')}` }]
        }
        return [part]
      }
      // Everything else (PDF, text, code, etc.) → path reference for agent to read
      return [{ type: 'text' as const, text: getAttachmentTextContent(part as FileMessagePartWithContent) }]
    })
    return { ...message, parts: normalizedParts } as UIMessage
  })
