import type { ModelMessage } from 'ai'
import type { OpencodeLogger, OpencodePartInput } from './types.js'

export interface ConversionResult {
  parts: OpencodePartInput[]
  warnings: string[]
}

function normalizeBase64(input: string): string {
  return input.replace(/^data:[^;]+;base64,/, '')
}

function uint8ArrayToBase64(input: Uint8Array): string {
  return Buffer.from(input).toString('base64')
}

function convertFilePart(
  part: Extract<NonNullable<ModelMessage['content']>[number], { type: 'file' }>,
  warnings: string[],
  logger?: OpencodeLogger | false,
): OpencodePartInput | null {
  if (typeof part.data === 'string') {
    if (part.data.startsWith('data:')) {
      return {
        type: 'file',
        mime: part.mediaType,
        filename: part.filename,
        url: part.data,
      }
    }
    if (part.data.startsWith('http://') || part.data.startsWith('https://')) {
      const warning = `Remote URLs are not supported for file input: ${part.data.slice(0, 50)}...`
      warnings.push(warning)
      logger && logger.warn(warning)
      return null
    }
    return {
      type: 'file',
      mime: part.mediaType,
      filename: part.filename,
      url: `data:${part.mediaType};base64,${normalizeBase64(part.data)}`,
    }
  }

  if (part.data instanceof Uint8Array) {
    return {
      type: 'file',
      mime: part.mediaType,
      filename: part.filename,
      url: `data:${part.mediaType};base64,${uint8ArrayToBase64(part.data)}`,
    }
  }

  if (part.data instanceof URL) {
    const url = part.data.toString()
    if (url.startsWith('data:')) {
      return {
        type: 'file',
        mime: part.mediaType,
        filename: part.filename,
        url,
      }
    }
    const warning = `Remote URLs are not supported for file input: ${url.slice(0, 50)}...`
    warnings.push(warning)
    logger && logger.warn(warning)
    return null
  }

  const warning = `Unsupported file data type: ${typeof part.data}`
  warnings.push(warning)
  logger && logger.warn(warning)
  return null
}

function convertImagePart(
  part: Extract<NonNullable<ModelMessage['content']>[number], { type: 'image' }>,
  warnings: string[],
  logger?: OpencodeLogger | false,
): OpencodePartInput | null {
  if (typeof part.image === 'string') {
    if (part.image.startsWith('data:')) {
      return {
        type: 'file',
        mime: part.mediaType ?? 'image/*',
        url: part.image,
      }
    }
    const warning = `Remote URLs are not supported for image input: ${part.image.slice(0, 50)}...`
    warnings.push(warning)
    logger && logger.warn(warning)
    return null
  }

  let buffer: Uint8Array
  if (part.image instanceof Uint8Array) {
    buffer = part.image
  } else if (part.image instanceof ArrayBuffer) {
    buffer = new Uint8Array(part.image)
  } else if (ArrayBuffer.isView(part.image)) {
    buffer = new Uint8Array(part.image.buffer, part.image.byteOffset, part.image.byteLength)
  } else {
    const warning = 'Unsupported image data type'
    warnings.push(warning)
    logger && logger.warn(warning)
    return null
  }

  return {
    type: 'file',
    mime: part.mediaType ?? 'image/*',
    url: `data:${part.mediaType ?? 'image/*'};base64,${uint8ArrayToBase64(buffer)}`,
  }
}

/**
 * OpenCode sessions are stateful on the server side — the server retains the
 * full conversation history internally. We must only send the latest user
 * message, mirroring the old adapter's `BaseProviderAdapter.extractLatestMessages`
 * behavior. Otherwise every turn re-sends the entire history, causing
 * exponential context growth and eventually "Session too large to compact" errors.
 */
export function convertToOpencodeMessages(
  messages: ModelMessage[],
  options?: {
    logger?: OpencodeLogger | false
    mode?: { type: 'regular' } | { type: 'object-json'; schema?: unknown }
  },
): ConversionResult {
  const parts: OpencodePartInput[] = []
  const warnings: string[] = []
  const logger = options?.logger

  // Find and convert only the latest user message.
  let latestUser: ModelMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      latestUser = messages[i]
      break
    }
  }

  if (latestUser) {
    if (typeof latestUser.content === 'string') {
      parts.push({ type: 'text', text: latestUser.content })
    } else {
      for (const part of latestUser.content) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text })
          continue
        }
        if (part.type === 'file') {
          const filePart = convertFilePart(part, warnings, logger)
          if (filePart) parts.push(filePart)
          continue
        }
        if (part.type === 'image') {
          const imagePart = convertImagePart(part, warnings, logger)
          if (imagePart) parts.push(imagePart)
        }
      }
    }
  }

  if (options?.mode?.type === 'object-json') {
    parts.push({
      type: 'text',
      text: `Respond with valid JSON only.${options.mode.schema ? ` Schema: ${JSON.stringify(options.mode.schema)}` : ''}`,
    })
  }

  return { parts, warnings }
}

export function isCompactCommand(messages: ModelMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (typeof message.content === 'string') {
      return message.content.trim() === '/compact'
    }
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim() === '/compact') {
        return true
      }
    }
    return false
  }
  return false
}
