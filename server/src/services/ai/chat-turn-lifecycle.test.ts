import { describe, expect, it } from 'vitest'
import { beginChatTurn, emitChatTurnFinished, isChatTurnBusy, isChatTurnStarting, markChatTurnReady, waitForChatTurnIdle } from './chat-turn-lifecycle.js'

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

describe('waitForChatTurnIdle', () => {
  it('resolves immediately when the chat has no turn in flight', async () => {
    await expect(waitForChatTurnIdle(710)).resolves.toBeUndefined()
  })

  it('waits for the turn to finish, not merely for some turn to finish', async () => {
    beginChatTurn(711, 'a')
    // A second turn is only admitted once the first is past setup.
    markChatTurnReady(711, 'a')
    expect(beginChatTurn(711, 'b')).toBe(true)
    let settled = false
    const idle = waitForChatTurnIdle(711).then(() => { settled = true })

    finish(711, 'a')
    await Promise.resolve()
    // 'b' is what the abort still has to wind down; answering here is what let
    // the client read a tail that was missing the reply on screen.
    expect(settled).toBe(false)

    finish(711, 'b')
    await idle
    expect(settled).toBe(true)
  })

  it('gives up rather than hanging a caller when the turn never ends', async () => {
    beginChatTurn(712, 'stuck')
    await expect(waitForChatTurnIdle(712, 10)).resolves.toBeUndefined()
    expect(isChatTurnBusy(712)).toBe(true)
    finish(712, 'stuck')
  })
})
