import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { convertToOpencodeMessages, isCompactCommand } from './message-mapper.js'

describe('opencode message mapper', () => {
  it('extracts only the latest user message, ignoring history', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'assistant reply' },
      { role: 'user', content: 'second turn' },
    ]

    const result = convertToOpencodeMessages(messages)

    expect(result.parts).toEqual([{ type: 'text', text: 'second turn' }])
    expect(result.warnings).toEqual([])
  })

  it('flattens multi-part user content into text/file parts', () => {
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'file',
          data: 'SGVsbG8=',
          mediaType: 'image/png',
          filename: 'hello.png',
        },
      ],
    }]

    const result = convertToOpencodeMessages(messages)

    expect(result.parts).toEqual([
      { type: 'text', text: 'look at this' },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'hello.png',
        url: 'data:image/png;base64,SGVsbG8=',
      },
    ])
  })

  it('warns and drops remote URL file inputs', () => {
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [{
        type: 'file',
        data: 'https://example.com/a.png',
        mediaType: 'image/png',
      }],
    }]

    const result = convertToOpencodeMessages(messages)

    expect(result.parts).toEqual([])
    expect(result.warnings.some((w) => w.includes('Remote URLs are not supported'))).toBe(true)
  })

  it('returns empty parts when history has no user message', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: 'hello' },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'search',
          output: { type: 'text', value: 'ok' },
        }],
      },
    ]

    const result = convertToOpencodeMessages(messages)

    expect(result.parts).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('appends a JSON instruction when mode is object-json', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'describe' }]

    const result = convertToOpencodeMessages(messages, {
      mode: { type: 'object-json', schema: { kind: 'thing' } },
    })

    expect(result.parts).toHaveLength(2)
    expect(result.parts[0]).toEqual({ type: 'text', text: 'describe' })
    expect(result.parts[1]).toMatchObject({ type: 'text' })
    expect((result.parts[1] as { text: string }).text).toContain('JSON')
    expect((result.parts[1] as { text: string }).text).toContain('"kind":"thing"')
  })
})

describe('isCompactCommand', () => {
  it('returns true when the latest user message is /compact', () => {
    expect(isCompactCommand([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '/compact' },
    ])).toBe(true)
  })

  it('returns true when the latest user content parts contain /compact', () => {
    expect(isCompactCommand([{
      role: 'user',
      content: [{ type: 'text', text: '/compact' }],
    }])).toBe(true)
  })

  it('returns false when the latest user message is not /compact', () => {
    expect(isCompactCommand([
      { role: 'user', content: '/compact' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'hello' },
    ])).toBe(false)
  })

  it('returns false when there is no user message', () => {
    expect(isCompactCommand([{ role: 'assistant', content: 'hello' }])).toBe(false)
  })
})
