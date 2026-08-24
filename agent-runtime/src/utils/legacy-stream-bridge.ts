import { randomUUID } from 'crypto'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
  LanguageModelV3Usage,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import type { RuntimeTextStreamPart } from '../types.js'

function asLanguageModelUsage(usage: LanguageModelV3Usage) {
  return {
    inputTokens: usage.inputTokens.total,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens.noCache,
      cacheReadTokens: usage.inputTokens.cacheRead,
      cacheWriteTokens: usage.inputTokens.cacheWrite,
    },
    outputTokens: usage.outputTokens.total,
    outputTokenDetails: {
      textTokens: usage.outputTokens.text,
      reasoningTokens: usage.outputTokens.reasoning,
    },
    totalTokens:
      usage.inputTokens.total !== undefined && usage.outputTokens.total !== undefined
        ? usage.inputTokens.total + usage.outputTokens.total
        : usage.inputTokens.total ?? usage.outputTokens.total,
    raw: usage.raw,
    reasoningTokens: usage.outputTokens.reasoning,
    cachedInputTokens: usage.inputTokens.cacheRead,
  }
}

function toLanguageModelDataContent(data: unknown): string | Uint8Array | URL {
  if (data instanceof URL) return data
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') return data
  throw new Error('Unsupported file data content')
}

function mapUserMessageToPromptMessage(message: ModelMessage): LanguageModelV3Message {
  if (message.role !== 'user') {
    throw new Error('Only user messages can be bridged into stateful runtime prompts')
  }

  if (typeof message.content === 'string') {
    return {
      role: 'user',
      content: [{ type: 'text', text: message.content }],
      providerOptions: message.providerOptions,
    }
  }

  const content: Array<LanguageModelV3FilePart | { type: 'text'; text: string; providerOptions?: SharedV3ProviderOptions }> = []

  for (const part of message.content) {
    if (part.type === 'text') {
      content.push({
        type: 'text',
        text: part.text,
        providerOptions: part.providerOptions as SharedV3ProviderOptions | undefined,
      })
      continue
    }

    if (part.type === 'file') {
      content.push({
        type: 'file',
        data: toLanguageModelDataContent(part.data),
        filename: part.filename,
        mediaType: part.mediaType,
        providerOptions: part.providerOptions,
      } satisfies LanguageModelV3FilePart)
      continue
    }

    if (part.type === 'image') {
      content.push({
        type: 'file',
        data: toLanguageModelDataContent(part.image),
        filename: undefined,
        mediaType: part.mediaType ?? 'image/*',
        providerOptions: part.providerOptions,
      } satisfies LanguageModelV3FilePart)
    }
  }

  return {
    role: 'user',
    content,
    providerOptions: message.providerOptions,
  }
}

export function extractLatestUserPrompt(messages: ModelMessage[]): LanguageModelV3Prompt {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') {
      return [mapUserMessageToPromptMessage(message)]
    }
  }

  return [{ role: 'user', content: [{ type: 'text', text: '' }] }]
}

function mapLegacyPart(
  part: LanguageModelV3StreamPart,
  toolCalls: Map<string, LanguageModelV3ToolCall>,
): RuntimeTextStreamPart | null {
  switch (part.type) {
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-end':
    case 'raw':
    case 'error':
      return part
    case 'tool-call':
      toolCalls.set(part.toolCallId, part)
      return part
    case 'tool-approval-request': {
      const toolCall = toolCalls.get(part.toolCallId)
      if (!toolCall) return null
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCall,
      }
    }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: toolCalls.get(part.toolCallId)?.input ?? {},
        output: part.result,
        providerExecuted: true,
        providerMetadata: part.providerMetadata,
        dynamic: part.dynamic,
        preliminary: part.preliminary,
      }
    case 'text-delta':
      return { type: 'text-delta', id: part.id, text: part.delta, providerMetadata: part.providerMetadata }
    case 'reasoning-delta':
      return { type: 'reasoning-delta', id: part.id, text: part.delta, providerMetadata: part.providerMetadata }
    case 'file':
      return {
        type: 'file',
        file: {
          base64: typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64'),
          mediaType: part.mediaType,
          uint8Array:
            typeof part.data === 'string'
              ? new Uint8Array(Buffer.from(part.data, 'base64'))
              : new Uint8Array(part.data),
        },
        providerMetadata: part.providerMetadata,
      }
    case 'source':
      return part
    case 'stream-start':
    case 'response-metadata':
    case 'finish':
      return null
  }
}

export async function* bridgeLegacyModelStream(
  model: LanguageModelV3,
  options: Omit<LanguageModelV3CallOptions, 'prompt'> & { prompt: LanguageModelV3Prompt },
): AsyncIterable<RuntimeTextStreamPart> {
  const { stream, request } = await model.doStream(options)
  let responseMetadata:
    | {
        id: string
        timestamp: Date
        modelId: string
        headers?: Record<string, string>
      }
    | undefined
  let finishPart: Extract<LanguageModelV3StreamPart, { type: 'finish' }> | undefined
  const toolCalls = new Map<string, LanguageModelV3ToolCall>()

  yield { type: 'start' }
  yield {
    type: 'start-step',
    request: {
      body: request?.body,
    },
    warnings: [],
  }

  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const part = next.value
    if (part.type === 'stream-start') {
      continue
    }

    if (part.type === 'response-metadata') {
      responseMetadata = {
        id: part.id ?? randomUUID(),
        timestamp: part.timestamp ?? new Date(),
        modelId: part.modelId ?? model.modelId,
      }
      continue
    }

    if (part.type === 'finish') {
      finishPart = part
      continue
    }

    const mapped = mapLegacyPart(part, toolCalls)
    if (mapped) {
      yield mapped
    }
  }

  const finalResponse = responseMetadata ?? {
    id: randomUUID(),
    timestamp: new Date(),
    modelId: model.modelId,
    headers: undefined,
  }

  const finalUsage = finishPart ? asLanguageModelUsage(finishPart.usage) : {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
    raw: undefined,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  }

  yield {
    type: 'finish-step',
    response: {
      id: finalResponse.id,
      timestamp: finalResponse.timestamp,
      modelId: finalResponse.modelId,
      ...(finalResponse.headers ? { headers: finalResponse.headers } : {}),
    },
    usage: finalUsage,
    finishReason: finishPart?.finishReason.unified ?? 'stop',
    rawFinishReason: finishPart?.finishReason.raw,
    providerMetadata: finishPart?.providerMetadata,
  }

  yield {
    type: 'finish',
    finishReason: finishPart?.finishReason.unified ?? 'stop',
    rawFinishReason: finishPart?.finishReason.raw,
    totalUsage: finalUsage,
  }
}
