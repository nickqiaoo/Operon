import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import type { ImageContent } from 'operon-agents'
import { buildAgentInput, parseSlashCommand, isSupportedCommand } from './session.js'

const user = (content: ModelMessage['content']): ModelMessage => ({ role: 'user', content } as ModelMessage)

describe('buildAgentInput', () => {
  it('returns a plain string for text-only string content', () => {
    expect(buildAgentInput([user('hello world')])).toBe('hello world')
  })

  it('joins text parts into a string when there are no images', () => {
    const input = buildAgentInput([user([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never)])
    expect(input).toBe('a\nb')
  })

  it('uses the latest user message, ignoring earlier turns', () => {
    const input = buildAgentInput([user('old'), { role: 'assistant', content: 'hi' } as ModelMessage, user('new')])
    expect(input).toBe('new')
  })

  it('emits a Message[] with text + ImageContent for image parts (data URL)', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    const input = buildAgentInput([
      user([{ type: 'text', text: 'look' }, { type: 'image', image: dataUrl }] as never),
    ])
    expect(Array.isArray(input)).toBe(true)
    const msg = (input as Array<{ role: string; content: unknown[] }>)[0]
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ])
  })

  it('handles file parts with raw base64 + mediaType', () => {
    const input = buildAgentInput([
      user([{ type: 'file', mediaType: 'image/jpeg', data: 'Zm9v' }] as never),
    ])
    const msg = (input as Array<{ content: ImageContent[] }>)[0]
    expect(msg.content[0]).toEqual({ type: 'image', data: 'Zm9v', mimeType: 'image/jpeg' })
  })

  it('skips remote image URLs the framework cannot fetch (falls back to text)', () => {
    const input = buildAgentInput([
      user([{ type: 'text', text: 'hi' }, { type: 'image', image: 'https://example.com/x.png' }] as never),
    ])
    expect(input).toBe('hi')
  })

  it('skips non-image file parts', () => {
    const input = buildAgentInput([
      user([{ type: 'text', text: 'doc' }, { type: 'file', mediaType: 'application/pdf', data: 'JVBER' }] as never),
    ])
    expect(input).toBe('doc')
  })
})

describe('parseSlashCommand', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' })
  })

  it('parses a command with args and lowercases the name', () => {
    expect(parseSlashCommand('/Plan on')).toEqual({ name: 'plan', args: 'on' })
  })

  it('preserves arg casing/spacing after the name', () => {
    expect(parseSlashCommand('/compact  Keep the API surface  ')).toEqual({ name: 'compact', args: 'Keep the API surface' })
  })

  it('returns null for non-command text', () => {
    expect(parseSlashCommand('just a message')).toBeNull()
    expect(parseSlashCommand('  hello /plan')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('only the advertised commands are supported', () => {
    expect(isSupportedCommand('compact')).toBe(true)
    expect(isSupportedCommand('plan')).toBe(true)
    expect(isSupportedCommand('goal')).toBe(false)
    expect(isSupportedCommand('bash')).toBe(false)
  })
})
