import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'

vi.mock('@/lib/assistant-api', () => ({
  assistantApi: { olderMessages: vi.fn(async () => ({ messages: [msg(-1)], hasMore: true })) },
  subscribeAssistant: vi.fn(),
}))

import { MESSAGE_WINDOW, useAssistantStore, windowed } from './assistant-store'

function msg(i: number): AssistantMessage {
  return { id: `m${i}`, role: 'assistant', text: `#${i}`, createdAt: 1_000 + i }
}
const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i))

describe('the message window', () => {
  it('keeps the newest MESSAGE_WINDOW and says there are earlier ones', () => {
    expect(windowed(many(MESSAGE_WINDOW), false)).toEqual({ messages: many(MESSAGE_WINDOW) })
    const trimmed = windowed(many(MESSAGE_WINDOW + 5), false)
    expect(trimmed.messages).toHaveLength(MESSAGE_WINDOW)
    expect(trimmed.messages[0]!.id).toBe('m5')
    expect(trimmed).toMatchObject({ hasMore: true })
  })

  it('leaves the list whole while the reader is up in pages they loaded', () => {
    expect(windowed(many(MESSAGE_WINDOW + 5), true).messages).toHaveLength(MESSAGE_WINDOW + 5)
  })

  it('loading earlier pages holds the window open until the reader is back at the bottom', async () => {
    useAssistantStore.setState({ messages: many(MESSAGE_WINDOW), hasMore: true, browsingOlder: false })
    await useAssistantStore.getState().loadOlder()
    expect(useAssistantStore.getState()).toMatchObject({ browsingOlder: true })
    expect(useAssistantStore.getState().messages).toHaveLength(MESSAGE_WINDOW + 1)

    useAssistantStore.getState().settleAtBottom()
    const after = useAssistantStore.getState()
    expect(after.browsingOlder).toBe(false)
    expect(after.messages).toHaveLength(MESSAGE_WINDOW)
    expect(after.messages.at(-1)!.id).toBe(`m${MESSAGE_WINDOW - 1}`)
    expect(after.hasMore).toBe(true)
  })
})
