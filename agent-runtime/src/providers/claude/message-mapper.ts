import type { ModelMessage } from 'ai'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeMappedPrompt } from './types.js'

type SDKUserContentPart = SDKUserMessage['message']['content'][number]

interface StreamingSegment {
  formatted: string
}

const IMAGE_URL_WARNING = 'Image URLs are not supported by this provider; supply base64/data URLs.'
const IMAGE_CONVERSION_WARNING = 'Unable to convert image content; supply base64/data URLs.'

function normalizeBase64(base64: string): string {
  return base64.replace(/\s+/g, '')
}

function isImageMimeType(mimeType?: string): boolean {
  return typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith('image/')
}

function createImageContent(mediaType: string, data: string): SDKUserContentPart | undefined {
  const trimmedType = mediaType.trim()
  const trimmedData = normalizeBase64(data.trim())
  if (!trimmedType || !trimmedData) return undefined

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: trimmedType,
      data: trimmedData,
    },
  } as SDKUserContentPart
}

function extractMimeType(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function parseObjectImage(
  imageObj: Record<string, unknown>,
  fallbackMimeType?: string,
): SDKUserContentPart | undefined {
  const data = typeof imageObj.data === 'string' ? imageObj.data : undefined
  const mimeType = extractMimeType(
    imageObj.mimeType ?? imageObj.mediaType ?? imageObj.media_type ?? fallbackMimeType,
  )
  if (!data || !mimeType) return undefined
  return createImageContent(mimeType, data)
}

function parseStringImage(
  value: string,
  fallbackMimeType?: string,
): { content?: SDKUserContentPart; warning?: string } {
  const trimmed = value.trim()

  if (/^https?:\/\//i.test(trimmed)) return { warning: IMAGE_URL_WARNING }

  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i)
  if (dataUrlMatch) {
    const [, mediaType, data] = dataUrlMatch
    const content = createImageContent(mediaType, data)
    return content ? { content } : { warning: IMAGE_CONVERSION_WARNING }
  }

  const base64Match = trimmed.match(/^base64:([^,]+),(.+)$/i)
  if (base64Match) {
    const [, explicitMimeType, data] = base64Match
    const content = createImageContent(explicitMimeType, data)
    return content ? { content } : { warning: IMAGE_CONVERSION_WARNING }
  }

  if (fallbackMimeType) {
    const content = createImageContent(fallbackMimeType, trimmed)
    if (content) return { content }
  }

  return { warning: IMAGE_CONVERSION_WARNING }
}

function parseImagePart(part: unknown): { content?: SDKUserContentPart; warning?: string } {
  if (!part || typeof part !== 'object') return { warning: IMAGE_CONVERSION_WARNING }

  const imageValue = (part as { image?: unknown }).image
  const mimeType = extractMimeType((part as { mimeType?: unknown }).mimeType)

  if (typeof imageValue === 'string') return parseStringImage(imageValue, mimeType)
  if (imageValue && typeof imageValue === 'object') {
    const content = parseObjectImage(imageValue as Record<string, unknown>, mimeType)
    return content ? { content } : { warning: IMAGE_CONVERSION_WARNING }
  }

  return { warning: IMAGE_CONVERSION_WARNING }
}

function convertBinaryToBase64(data: Uint8Array | ArrayBuffer): string | undefined {
  if (typeof Buffer !== 'undefined') {
    const buffer = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data))
    return buffer.toString('base64')
  }

  if (typeof btoa === 'function') {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize)
      binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
  }

  return undefined
}

type FileLikePart = {
  mediaType?: unknown
  mimeType?: unknown
  data?: unknown
}

function parseFilePart(part: FileLikePart): { content?: SDKUserContentPart; warning?: string } {
  const mimeType = extractMimeType(part.mediaType ?? part.mimeType)
  if (!mimeType || !isImageMimeType(mimeType)) return {}

  if (typeof part.data === 'string') {
    const content = createImageContent(mimeType, part.data)
    return content ? { content } : { warning: IMAGE_CONVERSION_WARNING }
  }

  if (
    part.data instanceof Uint8Array ||
    (typeof ArrayBuffer !== 'undefined' && part.data instanceof ArrayBuffer)
  ) {
    const base64 = convertBinaryToBase64(part.data)
    if (!base64) return { warning: IMAGE_CONVERSION_WARNING }
    const content = createImageContent(mimeType, base64)
    return content ? { content } : { warning: IMAGE_CONVERSION_WARNING }
  }

  return { warning: IMAGE_CONVERSION_WARNING }
}

/**
 * Claude Code CLI sessions are stateful — when resuming via `resume: sessionId`,
 * the CLI restores the full conversation history from disk. We must only pass
 * the latest user message to the mapper, mirroring the old adapter's
 * `BaseProviderAdapter.extractLatestMessages` behavior. Otherwise every turn
 * sends the entire history twice (once via resume, once via the prompt), causing
 * exponential context growth.
 */
function extractLatestUserMessage(prompt: readonly ModelMessage[]): ModelMessage[] {
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i]?.role === 'user') {
      return [prompt[i]]
    }
  }
  return []
}

export function convertToClaudeMessages(fullPrompt: readonly ModelMessage[]): ClaudeMappedPrompt {
  const prompt = extractLatestUserMessage(fullPrompt)
  const shouldUseRolePrefixes = !(prompt.length === 1 && prompt[0]?.role === 'user')
  const messages: string[] = []
  const warnings: string[] = []
  let systemPrompt: string | undefined
  const streamingSegments: StreamingSegment[] = []
  const imageMap = new Map<number, SDKUserContentPart[]>()
  let hasImageParts = false

  const addSegment = (formatted: string): number => {
    streamingSegments.push({ formatted })
    return streamingSegments.length - 1
  }

  const addImageForSegment = (segmentIndex: number, content: SDKUserContentPart): void => {
    hasImageParts = true
    if (!imageMap.has(segmentIndex)) imageMap.set(segmentIndex, [])
    imageMap.get(segmentIndex)?.push(content)
  }

  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        systemPrompt = message.content
        addSegment(typeof message.content === 'string' && message.content.trim().length > 0 ? message.content : '')
        break
      case 'user':
        if (typeof message.content === 'string') {
          messages.push(message.content)
          addSegment(shouldUseRolePrefixes ? `Human: ${message.content}` : message.content)
        } else {
          const textParts = message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')

          const segmentIndex = addSegment(
            textParts ? (shouldUseRolePrefixes ? `Human: ${textParts}` : textParts) : '',
          )
          if (textParts) messages.push(textParts)

          for (const part of message.content) {
            if (part.type === 'image') {
              const { content, warning } = parseImagePart(part)
              if (content) addImageForSegment(segmentIndex, content)
              else if (warning) warnings.push(warning)
            } else if (part.type === 'file') {
              const { content, warning } = parseFilePart(part)
              if (content) addImageForSegment(segmentIndex, content)
              else if (warning) warnings.push(warning)
            }
          }
        }
        break
      case 'assistant': {
        let assistantContent = ''
        if (typeof message.content === 'string') {
          assistantContent = message.content
        } else {
          const textParts = message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
          if (textParts) assistantContent = textParts
          const toolCalls = message.content.filter((part) => part.type === 'tool-call')
          if (toolCalls.length > 0) assistantContent += '\n[Tool calls made]'
        }
        const formattedAssistant = `Assistant: ${assistantContent}`
        messages.push(formattedAssistant)
        addSegment(formattedAssistant)
        break
      }
      case 'tool':
        for (const tool of message.content) {
          if (tool.type === 'tool-approval-response') continue

          let resultText = '[Unknown output type]'
          const output = tool.output
          if (output.type === 'text' || output.type === 'error-text') {
            resultText = output.value
          } else if (output.type === 'json' || output.type === 'error-json') {
            resultText = JSON.stringify(output.value)
          } else if (output.type === 'execution-denied') {
            resultText = `[Execution denied${output.reason ? `: ${output.reason}` : ''}]`
          } else if (output.type === 'content') {
            resultText = output.value
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
          }

          const formattedToolResult = `Tool Result (${tool.toolName}): ${resultText}`
          messages.push(formattedToolResult)
          addSegment(formattedToolResult)
        }
        break
    }
  }

  let finalPrompt = ''
  if (systemPrompt) finalPrompt = systemPrompt

  if (messages.length > 0) {
    const formattedMessages: string[] = []
    for (const message of messages) {
      if (message.startsWith('Assistant:') || message.startsWith('Tool Result')) {
        formattedMessages.push(message)
      } else {
        formattedMessages.push(shouldUseRolePrefixes ? `Human: ${message}` : message)
      }
    }

    if (finalPrompt) {
      const joinedMessages = formattedMessages.join('\n\n')
      finalPrompt = joinedMessages ? `${finalPrompt}\n\n${joinedMessages}` : finalPrompt
    } else {
      finalPrompt = formattedMessages.join('\n\n')
    }
  }

  const streamingParts: SDKUserContentPart[] = []
  const imagePartsInOrder: SDKUserContentPart[] = []

  const appendImagesForIndex = (index: number) => {
    const images = imageMap.get(index)
    if (!images) return
    images.forEach((image) => {
      streamingParts.push(image)
      imagePartsInOrder.push(image)
    })
  }

  if (streamingSegments.length > 0) {
    let accumulatedText = ''
    let emittedText = false

    const flushText = () => {
      if (!accumulatedText) return
      streamingParts.push({ type: 'text', text: accumulatedText })
      accumulatedText = ''
      emittedText = true
    }

    streamingSegments.forEach((segment, index) => {
      if (segment.formatted) {
        if (!accumulatedText) {
          accumulatedText = emittedText ? `\n\n${segment.formatted}` : segment.formatted
        } else {
          accumulatedText += `\n\n${segment.formatted}`
        }
      }

      if (imageMap.has(index)) {
        flushText()
        appendImagesForIndex(index)
      }
    })

    flushText()
  }

  return {
    messagesPrompt: finalPrompt,
    systemPrompt,
    ...(warnings.length > 0 ? { warnings } : {}),
    streamingContentParts:
      streamingParts.length > 0
        ? (streamingParts as SDKUserMessage['message']['content'])
        : ([{ type: 'text', text: finalPrompt }, ...imagePartsInOrder] as SDKUserMessage['message']['content']),
    hasImageParts,
  }
}
