import type { ModelMessage } from 'ai'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProtocolUserInput } from './sdk/protocol/index.js'
import type { ThreadMode } from './sdk/types/settings.js'

export interface CodexPromptWarning {
  type: 'other'
  message: string
}

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[]

export function safeJsonStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function isImageMediaType(mediaType?: string): boolean {
  return typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('image/')
}

function mediaTypeToExtension(mediaType: string): string {
  const lower = mediaType.toLowerCase()
  if (lower.includes('png')) return 'png'
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg'
  if (lower.includes('webp')) return 'webp'
  if (lower.includes('gif')) return 'gif'
  if (lower.includes('bmp')) return 'bmp'
  if (lower.includes('tiff')) return 'tiff'
  return 'img'
}

function writeTempImage(data: Uint8Array, mediaType: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-'))
  const ext = mediaTypeToExtension(mediaType)
  const filePath = join(dir, `image.${ext}`)
  writeFileSync(filePath, data)
  return filePath
}

export function cleanupTempFiles(paths: string[]): void {
  for (const filePath of paths) {
    try {
      rmSync(dirname(filePath), { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

type UserContentPart = NonNullable<Extract<ModelMessage, { role: 'user' }>['content']>[number]
function toLocalOrRemoteImageInput(
  mediaType: string,
  data: string | URL | Uint8Array,
  tempFiles: string[],
  warnings: CodexPromptWarning[],
): ProtocolUserInput | undefined {
  if (data instanceof URL) {
    if (data.protocol === 'file:') {
      return { type: 'localImage', path: fileURLToPath(data) }
    }
    if (data.protocol === 'http:' || data.protocol === 'https:' || data.protocol === 'data:') {
      return { type: 'image', imageUrl: data.href }
    }
    warnings.push({ type: 'other', message: `Unsupported image URL protocol "${data.protocol}".` })
    return undefined
  }

  if (typeof data === 'string') {
    if (data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')) {
      return { type: 'image', imageUrl: data }
    }
    if (data.startsWith('file://')) {
      try {
        return { type: 'localImage', path: fileURLToPath(data) }
      } catch {
        warnings.push({ type: 'other', message: 'Unable to read file URL for image input.' })
        return undefined
      }
    }
    try {
      const buffer = Buffer.from(data, 'base64')
      const filePath = writeTempImage(buffer, mediaType)
      tempFiles.push(filePath)
      return { type: 'localImage', path: filePath }
    } catch {
      warnings.push({ type: 'other', message: 'Unable to decode base64 image data.' })
      return undefined
    }
  }

  const filePath = writeTempImage(data, mediaType)
  tempFiles.push(filePath)
  return { type: 'localImage', path: filePath }
}

function convertUserFilePart(
  part: Extract<UserContentPart, { type: 'file' }>,
  tempFiles: string[],
  warnings: CodexPromptWarning[],
): ProtocolUserInput | undefined {
  if (!isImageMediaType(part.mediaType)) {
    warnings.push({
      type: 'other',
      message: `Unsupported file mediaType "${part.mediaType}"; only image/* is supported.`,
    })
    return undefined
  }
  if (typeof part.data === 'string' || part.data instanceof URL || part.data instanceof Uint8Array) {
    return toLocalOrRemoteImageInput(part.mediaType, part.data, tempFiles, warnings)
  }
  warnings.push({ type: 'other', message: 'Unsupported file data type provided in file input.' })
  return undefined
}

function convertUserImagePart(
  part: Extract<UserContentPart, { type: 'image' }>,
  tempFiles: string[],
  warnings: CodexPromptWarning[],
): ProtocolUserInput | undefined {
  const mediaType = part.mediaType ?? 'image/*'
  if (typeof part.image === 'string') {
    return toLocalOrRemoteImageInput(mediaType, part.image, tempFiles, warnings)
  }
  if (part.image instanceof Uint8Array) {
    return toLocalOrRemoteImageInput(mediaType, part.image, tempFiles, warnings)
  }
  if (part.image instanceof ArrayBuffer) {
    return toLocalOrRemoteImageInput(mediaType, new Uint8Array(part.image), tempFiles, warnings)
  }
  if (ArrayBuffer.isView(part.image)) {
    return toLocalOrRemoteImageInput(
      mediaType,
      new Uint8Array(part.image.buffer, part.image.byteOffset, part.image.byteLength),
      tempFiles,
      warnings,
    )
  }
  warnings.push({ type: 'other', message: 'Unsupported image data type provided in image input.' })
  return undefined
}

function extractUserMessagesForTurn(messages: ModelMessage[]): ModelMessage[] {
  const collected: ModelMessage[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user') {
      collected.push(message)
    } else if (collected.length) {
      break
    }
  }

  if (!collected.length) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'user') {
        collected.push(message)
        break
      }
    }
  }

  return collected.reverse()
}

function formatToolResultOutput(output: unknown): string {
  if (typeof output === 'string') return output
  return safeJsonStringify(output)
}

function assistantPartToTranscript(part: unknown): string[] {
  if (!part || typeof part !== 'object') return []
  const record = part as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') {
    return [`Assistant: ${record.text}`]
  }
  if (record.type === 'reasoning' && typeof record.text === 'string') {
    return [`Assistant reasoning: ${record.text}`]
  }
  if (record.type === 'tool-call' && typeof record.toolName === 'string') {
    return [`Tool Call (${record.toolName}): ${safeJsonStringify(record.input)}`]
  }
  if (record.type === 'tool-result' && typeof record.toolName === 'string') {
    return [`Tool Result (${record.toolName}): ${formatToolResultOutput(record.output)}`]
  }
  return []
}

function toolPartToTranscript(part: unknown): string[] {
  if (!part || typeof part !== 'object') return []
  const record = part as Record<string, unknown>
  if (record.type === 'tool-result' && typeof record.toolName === 'string') {
    return [`Tool Result (${record.toolName}): ${formatToolResultOutput(record.output)}`]
  }
  if (record.type === 'tool-approval-response' && typeof record.toolCallId === 'string') {
    const state = typeof record.approved === 'boolean' ? (record.approved ? 'approved' : 'denied') : 'updated'
    const reason = typeof record.reason === 'string' && record.reason ? ` (${record.reason})` : ''
    return [`Tool Approval (${record.toolCallId}): ${state}${reason}`]
  }
  return []
}

function buildTranscript(
  messages: ModelMessage[],
  warnings: CodexPromptWarning[],
  tempFiles: string[],
): { transcript: string; images: ProtocolUserInput[] } {
  const lines: string[] = []
  let lastUserImages: ProtocolUserInput[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      const textParts: string[] = []
      const images: ProtocolUserInput[] = []
      if (typeof message.content === 'string') {
        textParts.push(message.content)
      } else {
        for (const part of message.content) {
          if (part.type === 'text') {
            textParts.push(part.text)
            continue
          }
          if (part.type === 'file') {
            const input = convertUserFilePart(part, tempFiles, warnings)
            if (input) images.push(input)
            continue
          }
          if (part.type === 'image') {
            const input = convertUserImagePart(part, tempFiles, warnings)
            if (input) images.push(input)
          }
        }
      }

      const text = textParts.join('\n')
      const imageNote = images.length ? `[${images.length} image${images.length === 1 ? '' : 's'} attached]` : ''
      const combined = [text, imageNote].filter(Boolean).join('\n')
      if (combined) lines.push(`User: ${combined}`)
      if (images.length) lastUserImages = images
      continue
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        lines.push(`Assistant: ${message.content}`)
        continue
      }
      for (const part of message.content) {
        lines.push(...assistantPartToTranscript(part))
      }
      continue
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        lines.push(...toolPartToTranscript(part))
      }
    }
  }

  return { transcript: lines.join('\n\n'), images: lastUserImages }
}

export interface ConvertPromptResult {
  inputs: ProtocolUserInput[]
  warnings: CodexPromptWarning[]
  tempFiles: string[]
}

// System-role messages are skipped here by design: session instructions arrive
// via RuntimeSessionParams.instructions and land in developerInstructions.
export function convertPrompt(messages: ModelMessage[], threadMode: ThreadMode): ConvertPromptResult {
  const warnings: CodexPromptWarning[] = []
  const tempFiles: string[] = []

  if (threadMode === 'stateless') {
    const { transcript, images } = buildTranscript(messages, warnings, tempFiles)
    const inputs: ProtocolUserInput[] = []

    if (transcript.trim()) {
      inputs.push({ type: 'text', text: transcript })
    }
    inputs.push(...images)

    if (!inputs.length) {
      warnings.push({
        type: 'other',
        message: 'No user input found; starting a stateless turn with empty input.',
      })
    }

    return { inputs, warnings, tempFiles }
  }

  const inputs: ProtocolUserInput[] = []
  const userMessages = extractUserMessagesForTurn(messages)

  for (const message of userMessages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      if (message.content.trim()) inputs.push({ type: 'text', text: message.content })
      continue
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        inputs.push({ type: 'text', text: part.text })
        continue
      }
      if (part.type === 'file') {
        const input = convertUserFilePart(part, tempFiles, warnings)
        if (input) inputs.push(input)
        continue
      }
      if (part.type === 'image') {
        const input = convertUserImagePart(part, tempFiles, warnings)
        if (input) inputs.push(input)
      }
    }
  }

  if (!inputs.length) {
    warnings.push({
      type: 'other',
      message: 'No user input found; starting a turn with empty input.',
    })
  }

  return { inputs, warnings, tempFiles }
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
