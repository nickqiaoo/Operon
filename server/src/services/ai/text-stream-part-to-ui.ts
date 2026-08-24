import { createUIMessageStream, type UIMessage, type UIMessageStreamWriter } from 'ai'
import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import { normalizeToolInput } from './normalize-tool-input.js'

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

type StreamToUiOptions<UI_MESSAGE extends UIMessage> = {
  originalMessages: UI_MESSAGE[]
  messageId: string
  parts: AsyncIterable<RuntimeTextStreamPart>
  messageMetadata?: StreamMessageMetadataBuilder
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

export function createUiStreamFromTextParts<UI_MESSAGE extends UIMessage>({
  originalMessages,
  messageId,
  parts,
  messageMetadata,
}: StreamToUiOptions<UI_MESSAGE>): ReadableStream {
  return createUIMessageStream<UI_MESSAGE>({
    originalMessages,
    generateId: () => messageId,
    execute: async ({ writer }) => {
      for await (const part of parts) {
        writeTextStreamPart(writer, part, messageId, messageMetadata)
      }
    },
  })
}
