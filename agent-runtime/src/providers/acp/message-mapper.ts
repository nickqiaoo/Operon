import type * as acp from '@zed-industries/agent-client-protocol'
import type { ModelMessage } from 'ai'

export interface AcpPromptWarning {
  type: 'other'
  message: string
}

export interface AcpMessageConversionResult {
  prompt: acp.ContentBlock[]
  warnings: AcpPromptWarning[]
}

type UserContentPart = NonNullable<Extract<ModelMessage, { role: 'user' }>['content']>[number]

function normalizeBase64(input: string): string {
  return input.replace(/^data:[^;]+;base64,/, '')
}

function toBase64(mediaType: string, data: string | Uint8Array): { data: string; mimeType: string } {
  if (typeof data === 'string') {
    return { data: normalizeBase64(data), mimeType: mediaType }
  }
  return { data: Buffer.from(data).toString('base64'), mimeType: mediaType }
}

function convertImagePart(
  part: Extract<UserContentPart, { type: 'image' }>,
  warnings: AcpPromptWarning[],
): acp.ContentBlock | null {
  const mediaType = part.mediaType ?? 'image/png'
  if (typeof part.image === 'string') {
    // A remote/data URL string is passed through as an image content block.
    const { data, mimeType } = toBase64(mediaType, part.image)
    return { type: 'image', data, mimeType }
  }
  if (part.image instanceof Uint8Array) {
    const { data, mimeType } = toBase64(mediaType, part.image)
    return { type: 'image', data, mimeType }
  }
  if (part.image instanceof ArrayBuffer) {
    const { data, mimeType } = toBase64(mediaType, new Uint8Array(part.image))
    return { type: 'image', data, mimeType }
  }
  if (ArrayBuffer.isView(part.image)) {
    const view = part.image as ArrayBufferView
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    const { data, mimeType } = toBase64(mediaType, bytes)
    return { type: 'image', data, mimeType }
  }
  warnings.push({ type: 'other', message: 'Unsupported image data type for ACP runtime.' })
  return null
}

function convertFilePart(
  part: Extract<UserContentPart, { type: 'file' }>,
  warnings: AcpPromptWarning[],
): acp.ContentBlock | null {
  const mediaType = part.mediaType ?? 'application/octet-stream'
  if (mediaType.startsWith('image/')) {
    if (typeof part.data === 'string' || part.data instanceof Uint8Array) {
      const { data, mimeType } = toBase64(mediaType, part.data)
      return { type: 'image', data, mimeType }
    }
    if (part.data instanceof URL) {
      return { type: 'resource_link', name: part.filename ?? 'file', uri: part.data.toString(), mimeType: mediaType }
    }
  }
  if (part.data instanceof URL) {
    return { type: 'resource_link', name: part.filename ?? 'file', uri: part.data.toString(), mimeType: mediaType }
  }
  warnings.push({ type: 'other', message: `Unsupported file mediaType "${mediaType}" for ACP runtime.` })
  return null
}

/**
 * ACP sessions are stateful — each turn only carries the latest user message.
 * Convert it into ACP content blocks (text / image / resource link).
 */
export function convertToAcpPrompt(messages: ModelMessage[]): AcpMessageConversionResult {
  const warnings: AcpPromptWarning[] = []

  let latestUser: ModelMessage | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUser = messages[index]
      break
    }
  }

  if (!latestUser) {
    return { prompt: [{ type: 'text', text: '' }], warnings }
  }

  if (typeof latestUser.content === 'string') {
    return { prompt: [{ type: 'text', text: latestUser.content }], warnings }
  }

  const blocks: acp.ContentBlock[] = []
  for (const part of latestUser.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      const converted = convertImagePart(part, warnings)
      if (converted) blocks.push(converted)
      continue
    }
    if (part.type === 'file') {
      const converted = convertFilePart(part, warnings)
      if (converted) blocks.push(converted)
      continue
    }
    warnings.push({ type: 'other', message: `Unsupported user content part "${part.type}" for ACP runtime.` })
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' })
  }
  return { prompt: blocks, warnings }
}

/** Extract a plain-text preamble injector: prepend text to the first text block. */
export function prependTextToPrompt(prompt: acp.ContentBlock[], preamble: string): acp.ContentBlock[] {
  if (!preamble) return prompt
  const wrapped = `${preamble}\n\n---\n\n`
  const firstText = prompt.find((block) => block.type === 'text')
  if (firstText && firstText.type === 'text') {
    return prompt.map((block) =>
      block === firstText && block.type === 'text' ? { ...block, text: `${wrapped}${block.text}` } : block,
    )
  }
  return [{ type: 'text', text: wrapped }, ...prompt]
}
