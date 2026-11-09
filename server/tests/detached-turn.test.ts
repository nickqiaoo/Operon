import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { makeTestApp, type TestApp } from './helpers/make-app.js'
import { runDetachedTurn } from '../src/services/ai/detached-turn.js'
import { onChatTurnFinished, isChatTurnBusy, type ChatTurnFinished } from '../src/services/ai/chat-turn-lifecycle.js'
import { shutdown } from '../src/services/ai/state.js'

describe('independent background reply completion', () => {
  let ctx: TestApp | undefined
  afterEach(async () => { await shutdown(); ctx?.cleanup() })

  it('announces completion once, only after the stream ends and its final reply is stored', async () => {
    ctx = await makeTestApp()
    const storage = ctx.storage
    const chatId = storage.createChat({ tp: 'subagent', title: 'Background reply', providerId: 'fake', model: 'fake-1', updatedAt: Date.now() })
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((r) => { release = r }), entered = new Promise<void>((r) => { started = r })
    const events: ChatTurnFinished[] = []
    const unsubscribe = onChatTurnFinished((event) => {
      if (event.chatId !== chatId) return
      expect(storage.getChatEntry(chatId)?.messages.some((m) => m.id === event.message?.id)).toBe(true)
      events.push(event)
    })
    async function* output(): AsyncIterable<RuntimeStreamPart> {
      yield { type: 'text-start', id: 'reply' }
      yield { type: 'text-delta', id: 'reply', text: 'Before' }
      started(); await gate
      yield { type: 'text-delta', id: 'reply', text: ' and after' }
      yield { type: 'text-end', id: 'reply' }
    }
    try {
      const run = runDetachedTurn({ chatId, providerId: 'fake', logTag: 'test' }, output())
      await entered
      expect(events).toHaveLength(0); expect(isChatTurnBusy(chatId)).toBe(true)
      release(); await run
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe('completed')
      expect(events[0].message?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).toBe('Before and after')
      expect(isChatTurnBusy(chatId)).toBe(false)
    } finally { release(); unsubscribe() }
  })
})
