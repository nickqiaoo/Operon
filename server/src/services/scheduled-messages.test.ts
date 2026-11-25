import { afterEach, expect, it, vi } from 'vitest'
import { ScheduledMessages } from './scheduled-messages.js'

const { run, busy } = vi.hoisted(() => ({ run: vi.fn(), busy: vi.fn(() => false) }))
vi.mock('./ai/chat-flow.js', () => ({ runChatTurn: run, ChatBusyError: class extends Error {} }))
vi.mock('./ai/chat-turn-lifecycle.js', () => ({ isChatTurnBusy: busy }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('holds a due prompt during a turn, supports cancellation, and clears pending work on shutdown', async () => {
  vi.useFakeTimers()
  const queue = new ScheduledMessages({
    getChatMeta: () => ({ tp: 'chat', updatedAt: 0 }), createChat: () => 10,
  }, () => {})
  const add = (id: string) => queue.enqueue(Date.now() + 1000, { chatId: 10, messages: [
    { id, role: 'user', parts: [{ type: 'text', text: id }] },
  ] })
  busy.mockReturnValue(true)
  add('first')
  add('second')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).not.toHaveBeenCalled()
  expect(queue.cancel(10, 'second')).toBe(true)
  busy.mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(500)
  expect(run).toHaveBeenCalledTimes(1)
  expect(queue.list(10)).toEqual([])
  add('third')
  queue.stop()
  await vi.advanceTimersByTimeAsync(1500)
  expect(queue.list(10)).toEqual([])
  expect(run).toHaveBeenCalledTimes(1)
})
