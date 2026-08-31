import type {
  FileData,
  FilePart,
  ImagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  UserModelMessage,
} from '@ai-sdk/provider-utils'
import type { ModelMessage } from 'ai'
import type { Content, Part } from '@google/genai'

/**
 * Everything AI SDK v5+ accepts as a file/image payload. Beyond raw bytes and a
 * URL, v7 added a tagged `FileData` union and a bare provider reference
 * (`{ [provider]: fileId }`) — neither of which Gemini CLI Core can fetch.
 */
type FileInputData = FilePart['data'] | ImagePart['image']

const isFileData = (data: FileInputData): data is FileData =>
  typeof data === 'object' && data !== null && !(data instanceof URL) && 'type' in data

function toInlineData(data: FileInputData): string | Uint8Array {
  // v7 wraps payloads in a tagged union; unwrap the inline variant, reject the rest.
  if (isFileData(data)) {
    if (data.type === 'data') return toInlineData(data.data)
    throw new Error(
      `Gemini CLI Core needs inline file data, got a '${data.type}' file. Please provide inline data.`,
    )
  }
  if (data instanceof URL) {
    throw new Error('URL files are not supported by Gemini CLI Core. Please provide inline data.')
  }
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  // Only a provider reference is left — an id for a file uploaded to some other
  // provider, which Gemini CLI Core has no way to resolve.
  throw new Error(
    'Provider file references are not supported by Gemini CLI Core. Please provide inline data.',
  )
}

export function mapUserPart(part: TextPart | ImagePart | FilePart): Part {
  if (part.type === 'text') {
    return { text: part.text }
  }

  if (part.type === 'file') {
    const mediaType = part.mediaType || 'application/octet-stream'
    if (
      !mediaType.startsWith('image/') &&
      !mediaType.startsWith('audio/') &&
      !mediaType.startsWith('video/') &&
      mediaType !== 'application/pdf'
    ) {
      throw new Error(`Unsupported file type: ${mediaType}`)
    }
    const inlineData = toInlineData(part.data)
    return {
      inlineData: {
        mimeType: mediaType,
        data: typeof inlineData === 'string' ? inlineData : Buffer.from(inlineData).toString('base64'),
      },
    }
  }

  const inlineData = toInlineData(part.image)
  return {
    inlineData: {
      mimeType: part.mediaType ?? 'image/*',
      data: typeof inlineData === 'string' ? inlineData : Buffer.from(inlineData).toString('base64'),
    },
  }
}

export function mapMessagesToGeminiFormat(messages: ModelMessage[]): {
  contents: Content[]
} {
  const contents: Content[] = []

  for (const message of messages) {
    switch (message.role) {
      // System-role messages are skipped: session instructions arrive via
      // RuntimeSessionParams.instructions and land in the runtime's userMemory.
      case 'system':
        break
      case 'user': {
        const parts =
          typeof message.content === 'string'
            ? [{ text: message.content }]
            : message.content.map((part) => mapUserPart(part))
        contents.push({ role: 'user', parts })
        break
      }
      case 'assistant': {
        if (typeof message.content === 'string') {
          contents.push({ role: 'model', parts: [{ text: message.content }] })
          break
        }

        const parts: Part[] = []
        for (const part of message.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text })
            continue
          }
          if (part.type === 'tool-call') {
            const toolCallPart = part as ToolCallPart
            const providerOptions = toolCallPart.providerOptions
            const geminiCliOptions = providerOptions?.['gemini-cli'] as { thoughtSignature?: string } | undefined
            const thoughtSignature = geminiCliOptions?.thoughtSignature
            parts.push({
              functionCall: {
                name: toolCallPart.toolName,
                args: (toolCallPart.input ?? {}) as Record<string, unknown>,
              },
              ...(thoughtSignature ? { thoughtSignature } : {}),
            } as Part)
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts })
        }
        break
      }
      case 'tool': {
        const parts: Part[] = []
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue
          const toolResultPart = part as ToolResultPart
          const output = toolResultPart.output
          let response: Record<string, unknown>
          if (output.type === 'text' || output.type === 'error-text') {
            response = { result: output.value }
          } else if (output.type === 'json' || output.type === 'error-json') {
            const jsonValue = output.value
            response =
              jsonValue !== null && typeof jsonValue === 'object' && !Array.isArray(jsonValue)
                ? (jsonValue as Record<string, unknown>)
                : { result: jsonValue }
          } else if (output.type === 'execution-denied') {
            response = { result: `[Execution denied${output.reason ? `: ${output.reason}` : ''}]` }
          } else if (output.type === 'content') {
            response = {
              result: output.value
                .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
                .map((item) => item.text)
                .join('\n'),
            }
          } else {
            response = { result: '[Unknown output type]' }
          }
          parts.push({
            functionResponse: {
              name: toolResultPart.toolName,
              response,
            },
          })
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts })
        }
        break
      }
    }
  }

  return { contents }
}

export function extractLatestUserParts(messages: ModelMessage[]): Part[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const content = (message as UserModelMessage).content
    if (typeof content === 'string') {
      return [{ text: content }]
    }
    if (Array.isArray(content)) {
      return content.map((part) => mapUserPart(part))
    }
    return [{ text: '' }]
  }
  return [{ text: '' }]
}

export function isCompactCommand(messages: ModelMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const content = (message as UserModelMessage).content
    if (typeof content === 'string') {
      return content.trim() === '/compact'
    }
    for (const part of content) {
      if (part.type === 'text' && part.text.trim() === '/compact') {
        return true
      }
    }
    return false
  }
  return false
}
