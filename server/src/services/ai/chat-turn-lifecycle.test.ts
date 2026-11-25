import { describe, expect, it } from 'vitest'
import {
  beginChatTurn,
  emitChatTurnFinished,
  getChatTurnStatus,
  getChatTurnStream,
  isChatTurnBusy,
  isChatTurnStarting,
  listActiveChatTurns,
  markChatTurnReady,
  onChatTurnStatus,
  waitForChatTurnIdle,
  type ChatTurnStatus,
} from './chat-turn-lifecycle.js'
import { TurnStream } from './turn-stream.js'

const finish = (chatId: number, turnId: string) => emitChatTurnFinished({ chatId, turnId, status: 'completed' })

describe('chat turn startup admission', () => {
  it('rejects concurrent setup immediately and permits ordinary preemption after startup', () => {
    expect(beginChatTurn(701, 'first')).toBe(true)
    expect(isChatTurnStarting(701)).toBe(true)
    expect(beginChatTurn(701, 'concurrent')).toBe(false)
    expect(beginChatTurn(702, 'other')).toBe(true)
    markChatTurnReady(701, 'first')
    expect(beginChatTurn(701, 'notification', { admission: 'idle-only' })).toBe(false)
    expect(beginChatTurn(701, 'user')).toBe(true)
    finish(701, 'first')
    expect(isChatTurnBusy(701)).toBe(true)
    markChatTurnReady(701, 'user')
    finish(701, 'user')
    expect(beginChatTurn(701, 'notification', { admission: 'idle-only' })).toBe(true)
    finish(701, 'notification')
    finish(702, 'other')
    expect(isChatTurnBusy(701)).toBe(false)
  })
})

describe('waitForChatTurnIdle', () => {
  it('resolves immediately when the chat has no turn in flight', async () => {
    await expect(waitForChatTurnIdle(710)).resolves.toBe(true)
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
    await expect(waitForChatTurnIdle(712, 10)).resolves.toBe(false)
    expect(isChatTurnBusy(712)).toBe(true)
    finish(712, 'stuck')
  })
})

describe('chat turn status', () => {
  it('reports a turn from the moment it is admitted — setup included — until it finishes', () => {
    const seen: ChatTurnStatus[] = []
    const unsubscribe = onChatTurnStatus((status) => { if (status.chatId === 720) seen.push(status) })

    expect(getChatTurnStatus(720).active).toBe(false)
    beginChatTurn(720, 'r1')
    expect(seen.map((s) => [s.active, s.turnId])).toEqual([[true, 'r1']])
    expect(listActiveChatTurns().some((s) => s.chatId === 720)).toBe(true)

    markChatTurnReady(720, 'r1') // no change anyone needs to hear about
    expect(seen).toHaveLength(1)

    finish(720, 'r1')
    expect(seen.map((s) => [s.active, s.turnId])).toEqual([[true, 'r1'], [false, null]])
    expect(listActiveChatTurns().some((s) => s.chatId === 720)).toBe(false)
    unsubscribe()
  })

  it('reports the newest turn while a preempted one winds down', () => {
    beginChatTurn(721, 'old')
    markChatTurnReady(721, 'old')
    beginChatTurn(721, 'new')
    finish(721, 'old')
    expect(getChatTurnStatus(721)).toMatchObject({ active: true, turnId: 'new' })
    finish(721, 'new')
  })

  it('reports a refused turn nowhere', () => {
    const seen: ChatTurnStatus[] = []
    beginChatTurn(722, 'first')
    const unsubscribe = onChatTurnStatus((status) => { if (status.chatId === 722) seen.push(status) })
    expect(beginChatTurn(722, 'refused')).toBe(false)
    expect(seen).toHaveLength(0)
    expect(getChatTurnStatus(722).turnId).toBe('first')
    unsubscribe()
    finish(722, 'first')
  })
})

describe('chat turn stream', () => {
  it("is the newest turn's, then the finished one's for a moment", () => {
    const old = new TurnStream('old')
    const next = new TurnStream('new')
    beginChatTurn(730, 'old', { stream: old })
    expect(getChatTurnStream(730)).toBe(old)
    markChatTurnReady(730, 'old')
    beginChatTurn(730, 'new', { stream: next })
    expect(getChatTurnStream(730)).toBe(next)
    finish(730, 'old')
    finish(730, 'new')
    // Over, but a client that blinked out right at the end still finds it.
    expect(getChatTurnStream(730)).toBe(next)
  })

  it('is none for a turn kept off screen, though the chat shows busy', () => {
    beginChatTurn(731, 'compact')
    expect(getChatTurnStatus(731).active).toBe(true)
    expect(getChatTurnStream(731)).toBeUndefined()
    finish(731, 'compact')
  })
})
