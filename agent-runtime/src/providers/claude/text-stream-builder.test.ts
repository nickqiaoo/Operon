import { describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '../../types.js'
import { ClaudeTextStreamBuilder } from './text-stream-builder.js'

function createBuilder(parts: RuntimeStreamPart[]) {
  const controller = {
    enqueue: (part: RuntimeStreamPart) => {
      parts.push(part)
    },
  } as ReadableStreamDefaultController<RuntimeStreamPart>

  return new ClaudeTextStreamBuilder({
    controller,
    modelId: 'sonnet',
    requestBody: { prompt: 'hello' },
    warnings: [],
    getSessionId: () => undefined,
  })
}

describe('ClaudeTextStreamBuilder', () => {
  it('does not flush a step for plain user echo messages', () => {
    const parts: RuntimeStreamPart[] = []
    const builder = createBuilder(parts)

    builder.emitStart()
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      } as never,
      false,
    )
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hi' },
        },
      } as never,
      false,
    )
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'message_stop',
        },
      } as never,
      false,
    )

    builder.handleUserMessage({
      type: 'user',
      message: {
        role: 'user',
        content: 'hello',
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    } as never)

    builder.handleAssistantMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi! How can I help you today?' }],
        },
        parent_tool_use_id: null,
        session_id: 'session-1',
      } as never,
      false,
    )

    builder.handleResult(
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        usage: {
          input_tokens: 10,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      } as never,
      false,
    )

    expect(parts.filter((part) => part.type === 'start-step')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'finish-step')).toHaveLength(1)
  })

  it('keeps tool state across multiple user tool error messages in the same step', () => {
    const parts: RuntimeStreamPart[] = []
    const builder = createBuilder(parts)

    builder.emitStart()
    builder.handleAssistantMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/a.ts' },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Read',
              input: { file_path: '/tmp/b.ts' },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'session-1',
      } as never,
      false,
    )

    builder.handleUserMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_error',
            tool_use_id: 'tool-1',
            error: 'File does not exist',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    } as never)

    builder.handleUserMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_error',
            tool_use_id: 'tool-2',
            error: 'File does not exist',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    } as never)

    builder.handleResult(
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      } as never,
      false,
    )

    const toolCalls = parts.filter((part): part is Extract<RuntimeStreamPart, { type: 'tool-call' }> => part.type === 'tool-call')
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls.map((part) => part.toolName)).toEqual(['Read', 'Read'])
    expect(toolCalls.map((part) => part.input)).toEqual([
      '{"file_path":"/tmp/a.ts"}',
      '{"file_path":"/tmp/b.ts"}',
    ])

    const toolErrors = parts.filter((part): part is Extract<RuntimeStreamPart, { type: 'tool-error' }> => part.type === 'tool-error')
    expect(toolErrors).toHaveLength(2)
    expect(toolErrors.map((part) => part.toolName)).toEqual(['Read', 'Read'])
  })

  it('does not emit duplicate text-end when a text block is closed before content_block_stop', () => {
    const parts: RuntimeStreamPart[] = []
    const builder = createBuilder(parts)

    builder.emitStart()
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
      } as never,
      false,
    )
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      } as never,
      false,
    )
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
      } as never,
      false,
    )
    builder.handleStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      } as never,
      false,
    )

    const textStarts = parts.filter((part): part is Extract<RuntimeStreamPart, { type: 'text-start' }> => part.type === 'text-start')
    const textEnds = parts.filter((part): part is Extract<RuntimeStreamPart, { type: 'text-end' }> => part.type === 'text-end')

    expect(textStarts).toHaveLength(1)
    expect(textEnds).toHaveLength(1)
    expect(textEnds[0]?.id).toBe(textStarts[0]?.id)
  })
})
