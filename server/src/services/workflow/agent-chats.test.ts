import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const fixture = vi.hoisted(() => ({
  messages: [] as unknown[],
  stream: undefined as { isDone: boolean; messageId?: string; snapshotChunks: () => unknown[] } | undefined,
}))
vi.mock('../ai/state.js', () => ({
  getChatStorage: () => ({ getChatEntry: () => ({ providerId: 'codex', messages: fixture.messages }) }),
}))
vi.mock('../ai/chat-turn-lifecycle.js', () => ({ getChatTurnStream: () => fixture.stream }))

const { chunksFromMessages, chunksFromStream, readAgentChatChunks } = await import('./agent-chats.js')

const user = (id: string, text: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) }) as UIMessage

describe('an agent chat as the run panel\'s chunks', () => {
  it('leaves out the prompt and replays text and tool calls in order', () => {
    const chunks = chunksFromMessages([
      user('u1', 'the whole prompt'),
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool-Read', toolCallId: 'c1', state: 'output-available', input: { file_path: 'a.ts' } },
          { type: 'dynamic-tool', toolName: 'mcp__x', toolCallId: 'c2', state: 'output-error', input: {} },
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', text: 'Done.' },
        ],
      } as unknown as UIMessage,
    ])
    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Reading.' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool-output-available', toolCallId: 'c1' },
      { type: 'tool-input-available', toolCallId: 'c2', toolName: 'mcp__x', input: {} },
      { type: 'tool-output-error', toolCallId: 'c2' },
      { type: 'text-delta', delta: 'Done.' },
    ])
  })

  it('shows a steer once, where the agent took it in, and a later message from a person', () => {
    const chunks = chunksFromMessages([
      user('u1', 'prompt'),
      user('s1', 'sketch only', { steer: true }),
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Starting.' },
          { type: 'data-injected-input', id: 's1', data: { id: 's1', text: 'sketch only' } },
          { type: 'text', text: 'Sketching.' },
        ],
      } as unknown as UIMessage,
      user('u2', 'why that way?'),
    ])
    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Starting.' },
      { type: 'data-steer', data: { text: 'sketch only' } },
      { type: 'text-delta', delta: 'Sketching.' },
      { type: 'data-steer', data: { text: 'why that way?' } },
    ])
  })

  it('reads a turn still going from its stream', () => {
    expect(chunksFromStream([
      { type: 'start', messageId: 'm' },
      { type: 'text-delta', id: 't', delta: 'Hel' },
      { type: 'data-injected-input', id: 's', data: { id: 's', text: 'faster' } },
    ])).toEqual([
      { type: 'start', messageId: 'm' },
      { type: 'text-delta', id: 't', delta: 'Hel' },
      { type: 'data-steer', data: { text: 'faster' } },
    ])
  })
})

describe('an agent chat with a turn still running', () => {
  const assistant = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

  it('stands the stream in for the running reply', () => {
    fixture.messages = [user('u1', 'prompt'), assistant('a1', 'checkpoint')]
    fixture.stream = { isDone: false, messageId: 'a1', snapshotChunks: () => [{ type: 'text-delta', delta: 'live so far' }] }
    expect(readAgentChatChunks([1])).toEqual([{ type: 'text-delta', delta: 'live so far' }])
  })

  it('leaves the running turn out for a settled reader, steers sent into it included', () => {
    fixture.messages = [
      user('u1', 'prompt'),
      assistant('a0', 'earlier turn'),
      user('u2', 'a message after'),
      user('s1', 'go faster', { steer: true, turnMessageId: 'a1' }),
      assistant('a1', 'checkpoint'),
    ]
    fixture.stream = { isDone: false, messageId: 'a1', snapshotChunks: () => [{ type: 'text-delta', delta: 'live' }] }
    expect(readAgentChatChunks([1], { settled: true })).toEqual([
      { type: 'text-delta', delta: 'earlier turn' },
      { type: 'data-steer', data: { text: 'a message after' } },
    ])
  })
})
