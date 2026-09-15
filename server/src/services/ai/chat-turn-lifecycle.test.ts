import { describe, expect, it } from 'vitest'
import { beginChatTurn, emitChatTurnFinished, isChatTurnBusy, isChatTurnStarting, markChatTurnReady } from './chat-turn-lifecycle.js'

const finish = (chatId: number, turnId: string) => emitChatTurnFinished({ chatId, turnId, status: 'completed' })

describe('chat turn startup admission', () => {
  it('rejects concurrent setup immediately and permits ordinary preemption after startup', () => {
    expect(beginChatTurn(701, 'first')).toBe(true)
    expect(isChatTurnStarting(701)).toBe(true)
    expect(beginChatTurn(701, 'concurrent')).toBe(false)
    expect(beginChatTurn(702, 'other')).toBe(true)
    markChatTurnReady(701, 'first')
    expect(beginChatTurn(701, 'notification', true)).toBe(false)
    expect(beginChatTurn(701, 'user')).toBe(true)
    finish(701, 'first')
    expect(isChatTurnBusy(701)).toBe(true)
    markChatTurnReady(701, 'user')
    finish(701, 'user')
    expect(beginChatTurn(701, 'notification', true)).toBe(true)
    finish(701, 'notification')
    finish(702, 'other')
    expect(isChatTurnBusy(701)).toBe(false)
  })
})
