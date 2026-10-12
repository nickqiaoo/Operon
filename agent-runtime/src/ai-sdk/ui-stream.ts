import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from 'ai'
import { isUserFacingRuntimeError, type RuntimeStreamPart, type RuntimeTextStreamPart } from '../types.js'
import { normalizeToolInput } from './normalize-tool-input.js'

/**
 * Turn a session's stream into the AI SDK's UI message stream — what `useChat`
 * and AI Elements render. The runtime streams `TextStreamPart`s (the layer
 * `streamText().fullStream` yields); the AI SDK only converts that layer to UI
 * chunks inside `streamText`, so this is the same conversion, for a stream that
 * came from an agent instead.
 */

export type StreamMessageMetadataBuilder = (part: RuntimeTextStreamPart) => Record<string, unknown> | undefined

export function writeMessageMetadata<UI_MESSAGE extends UIMessage>(
  writer: UIMessageStreamWriter<UI_MESSAGE>,
  metadata: Record<string, unknown>,
): void {
  writer.write({
    type: 'message-metadata',
    messageMetadata: metadata as never,
  })
}

export function writeTextStreamPart<UI_MESSAGE extends UIMessage>(
  writer: UIMessageStreamWriter<UI_MESSAGE>,
  part: RuntimeTextStreamPart,
  messageId: string,
  messageMetadata?: StreamMessageMetadataBuilder,
): void {
  const metadataValue = messageMetadata?.(part)

  switch (part.type) {
    case 'start':
      writer.write({
        type: 'start',
        messageId,
        ...(metadataValue !== undefined ? { messageMetadata: metadataValue as never } : {}),
      })
      return
    case 'finish':
      writer.write({
        type: 'finish',
        finishReason: part.finishReason,
        ...(metadataValue !== undefined ? { messageMetadata: metadataValue as never } : {}),
      })
      return
    case 'start-step':
      writer.write({ type: 'start-step' })
      break
    case 'finish-step':
      writer.write({ type: 'finish-step' })
      break
    case 'text-start':
      writer.write({
        type: 'text-start',
        id: part.id,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'text-delta':
      writer.write({
        type: 'text-delta',
        id: part.id,
        delta: part.text,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'text-end':
      writer.write({
        type: 'text-end',
        id: part.id,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'reasoning-start':
      writer.write({
        type: 'reasoning-start',
        id: part.id,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'reasoning-delta':
      writer.write({
        type: 'reasoning-delta',
        id: part.id,
        delta: part.text,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'reasoning-end':
      writer.write({
        type: 'reasoning-end',
        id: part.id,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'tool-input-start':
      writer.write({
        type: 'tool-input-start',
        toolCallId: part.id,
        toolName: part.toolName,
        ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
        ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
        ...(part.title !== undefined ? { title: part.title } : {}),
      })
      break
    case 'tool-input-delta':
      writer.write({
        type: 'tool-input-delta',
        toolCallId: part.id,
        inputTextDelta: part.delta,
      })
      break
    case 'tool-call':
      const normalizedInput = normalizeToolInput(part.input)
      if (part.invalid) {
        writer.write({
          type: 'tool-input-error',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: normalizedInput,
          ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
          errorText: part.error instanceof Error ? part.error.message : String(part.error ?? 'Invalid tool call'),
          ...(part.title !== undefined ? { title: part.title } : {}),
        })
      } else {
        writer.write({
          type: 'tool-input-available',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: normalizedInput,
          ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
          ...(part.title !== undefined ? { title: part.title } : {}),
        })
      }
      break
    case 'tool-approval-request':
      writer.write({
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.toolCall.toolCallId,
      })
      break
    case 'tool-result':
      writer.write({
        type: 'tool-output-available',
        toolCallId: part.toolCallId,
        output: part.output,
        ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
        ...(part.preliminary !== undefined ? { preliminary: part.preliminary } : {}),
        ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
      })
      break
    case 'tool-error':
      writer.write({
        type: 'tool-output-error',
        toolCallId: part.toolCallId,
        errorText: part.error instanceof Error ? part.error.message : String(part.error ?? 'Tool execution failed'),
        ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
        ...(part.dynamic !== undefined ? { dynamic: part.dynamic } : {}),
      })
      break
    case 'tool-output-denied':
      writer.write({
        type: 'tool-output-denied',
        toolCallId: part.toolCallId,
      })
      break
    case 'file':
      writer.write({
        type: 'file',
        mediaType: part.file.mediaType,
        url: `data:${part.file.mediaType};base64,${part.file.base64}`,
        ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
      })
      break
    case 'source':
      if (part.sourceType === 'url') {
        writer.write({
          type: 'source-url',
          sourceId: part.id,
          url: part.url,
          title: part.title,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
        })
      } else if (part.sourceType === 'document') {
        writer.write({
          type: 'source-document',
          sourceId: part.id,
          mediaType: part.mediaType,
          title: part.title,
          filename: part.filename,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
        })
      }
      break
    case 'error':
      writer.write({
        type: 'error',
        errorText: part.error instanceof Error ? part.error.message : String(part.error ?? 'Unknown error'),
      })
      break
    case 'abort':
      writer.write(part)
      break
    case 'tool-input-end':
    case 'raw':
      break
  }

  if (metadataValue !== undefined) {
    writeMessageMetadata(writer, metadataValue)
  }
}

export interface ToUIMessageStreamOptions<UI_MESSAGE extends UIMessage = UIMessage> {
  /** The assistant message id the chunks belong to. */
  messageId: string
  /** The conversation so far, for the AI SDK's message assembly. */
  originalMessages?: UI_MESSAGE[]
  /**
   * Text for an error the client will see — a thrown one or an `error` part.
   * Defaults to the message of a `UserFacingRuntimeError` and a generic notice
   * for anything else, so internals never reach the browser.
   */
  onError?: (error: unknown) => string
  /** Message metadata to attach at a part, on top of the session's own `message-metadata` parts. */
  messageMetadata?: StreamMessageMetadataBuilder
}

const defaultErrorText = (error: unknown): string =>
  isUserFacingRuntimeError(error) ? error.message : 'An error occurred.'

export function toUIMessageStream<UI_MESSAGE extends UIMessage = UIMessage>(
  parts: AsyncIterable<RuntimeStreamPart>,
  options: ToUIMessageStreamOptions<UI_MESSAGE>,
): ReadableStream<UIMessageChunk> {
  const onError = options.onError ?? defaultErrorText
  return createUIMessageStream<UI_MESSAGE>({
    originalMessages: options.originalMessages ?? [],
    generateId: () => options.messageId,
    onError,
    execute: async ({ writer }) => {
      for await (const part of parts) {
        if (part.type === 'message-metadata') {
          writeMessageMetadata(writer, part.metadata)
        } else if (part.type === 'error') {
          writer.write({ type: 'error', errorText: onError(part.error) })
        } else {
          writeTextStreamPart(writer, part, options.messageId, options.messageMetadata)
        }
      }
    },
  })
}

/** `toUIMessageStream` as a streaming HTTP response, for a route handler. */
export function toUIMessageStreamResponse<UI_MESSAGE extends UIMessage = UIMessage>(
  parts: AsyncIterable<RuntimeStreamPart>,
  options: ToUIMessageStreamOptions<UI_MESSAGE> & { headers?: Record<string, string>; status?: number },
): Response {
  const { headers, status, ...streamOptions } = options
  return createUIMessageStreamResponse({
    stream: toUIMessageStream(parts, streamOptions),
    ...(headers ? { headers } : {}),
    ...(status ? { status } : {}),
  })
}
