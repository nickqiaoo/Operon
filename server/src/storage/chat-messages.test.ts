import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-chat-messages-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

interface Msg { id: string; role: string; parts: Array<Record<string, unknown>>; metadata?: unknown }

const msg = (id: string, role: 'user' | 'assistant', ...texts: string[]): Msg =>
  ({ id, role, parts: texts.map((text) => ({ type: 'text', text })) })

const newChat = (...messages: Msg[]): number =>
  storage.createChat({ tp: 'chat', title: 'Chat', updatedAt: 1, messages })

const messagesOf = (chatId: number): Msg[] => storage.getChatEntry(chatId)?.messages as Msg[]
const ids = (chatId: number): string[] => messagesOf(chatId).map((m) => m.id)
const texts = (chatId: number, id: string): unknown[] =>
  messagesOf(chatId).find((m) => m.id === id)!.parts.map((p) => p.text)
const partRows = (): number =>
  (storage.getDatabase().prepare('SELECT COUNT(*) AS n FROM chat_message_parts').get() as { n: number }).n

describe.skipIf(!opened)('chat message storage', () => {
  it('stores a message as head + parts and reads it back unchanged', () => {
    const message = {
      id: 'a1', role: 'assistant', metadata: { model: 'x' }, content: 'legacy',
      parts: [{ type: 'step-start' }, { type: 'text', text: 'hi', state: 'done' }, { type: 'dynamic-tool', toolCallId: 't', state: 'output-available', input: { q: 1 }, output: [1, 2] }],
    }
    const chatId = newChat(msg('u1', 'user', 'hello'), message as Msg)
    expect(messagesOf(chatId)).toEqual([msg('u1', 'user', 'hello'), message])
  })

  it('appends a new id, then replaces it in place, writing only the parts it is given', () => {
    const chatId = newChat(msg('u1', 'user', 'q'))
    storage.putChatMessage(chatId, { message: msg('a1', 'assistant', 'one', 'two'), updatedAt: 2 })
    const result = storage.putChatMessage(chatId, {
      message: msg('a1', 'assistant', 'ONE', 'TWO', 'three'),
      partIndices: [1, 2],
      updatedAt: 3,
    })
    expect(result).toEqual({ written: true, bytes: expect.any(Number) })
    expect(ids(chatId)).toEqual(['u1', 'a1'])
    // Part 0 was not listed, so the stored one stays.
    expect(texts(chatId, 'a1')).toEqual(['one', 'TWO', 'three'])
  })

  it('drops stored parts past the end of a shorter message', () => {
    const chatId = newChat(msg('a1', 'assistant', 'a', 'b', 'c'))
    storage.putChatMessage(chatId, { message: msg('a1', 'assistant', 'a'), partIndices: [] })
    expect(texts(chatId, 'a1')).toEqual(['a'])
  })

  it('puts a steer ahead of the reply being written, which is the last message', () => {
    const chatId = newChat(msg('u1', 'user', 'q'), msg('a1', 'assistant', 'partial'))
    storage.putChatMessage(chatId, { message: msg('s1', 'user', 'steer 1'), before: 'a1' })
    storage.putChatMessage(chatId, { message: msg('s2', 'user', 'steer 2'), before: 'a1' })
    expect(ids(chatId)).toEqual(['u1', 's1', 's2', 'a1'])
    expect(texts(chatId, 'a1')).toEqual(['partial'])
  })

  it('appends when the message to go before is missing or not last', () => {
    const chatId = newChat(msg('u1', 'user', 'q'), msg('a1', 'assistant', 'r'))
    storage.putChatMessage(chatId, { message: msg('s1', 'user', 'early'), before: 'not-saved-yet' })
    storage.putChatMessage(chatId, { message: msg('s2', 'user', 'stale'), before: 'u1' })
    expect(ids(chatId)).toEqual(['u1', 'a1', 's1', 's2'])
  })

  it('keeps the stored message with ifAbsent, and leaves the chat row alone', () => {
    const chatId = storage.createChat({ tp: 'chat', title: 'Chat', model: 'm1', updatedAt: 1, messages: [msg('u1', 'user', 'q')] })
    const result = storage.putChatMessage(chatId, {
      message: msg('u1', 'user', 'changed'), ifAbsent: true, chat: { model: 'm2' }, updatedAt: 9,
    })
    expect(result).toEqual({ written: false, bytes: 0 })
    expect(texts(chatId, 'u1')).toEqual(['q'])
    expect(storage.getChatMeta(chatId)).toMatchObject({ model: 'm1', updatedAt: 1 })
  })

  it('sets chat fields that are given and keeps the rest, stamping updated_at only when asked', () => {
    const chatId = storage.createChat({ tp: 'side', title: 'Side', model: 'm1', providerId: 'p1', updatedAt: 1 })
    storage.putChatMessage(chatId, { message: msg('a1', 'assistant', 'r'), chat: { sessionId: 's' } })
    expect(storage.getChatMeta(chatId)).toMatchObject({ tp: 'side', model: 'm1', providerId: 'p1', sessionId: 's', updatedAt: 1 })
    storage.putChatMessage(chatId, { message: msg('a1', 'assistant', 'r2'), chat: { model: 'm2' }, updatedAt: 5 })
    expect(storage.getChatMeta(chatId)).toMatchObject({ tp: 'side', model: 'm2', updatedAt: 5 })
    storage.updateChatConfig(chatId, { providerId: 'p2', thinkingLevel: 'high' })
    expect(storage.getChatMeta(chatId)).toMatchObject({ providerId: 'p2', thinkingLevel: 'high', updatedAt: 5 })
  })

  it('returns undefined for a chat that does not exist', () => {
    expect(storage.putChatMessage(987654, { message: msg('x', 'user', 'q') })).toBeUndefined()
  })

  it('pages backwards over an order with gaps', () => {
    const chatId = newChat(msg('u1', 'user', '1'), msg('a1', 'assistant', '2'))
    storage.putChatMessage(chatId, { message: msg('s1', 'user', '3'), before: 'a1' })
    storage.putChatMessage(chatId, { message: msg('u2', 'user', '4') })
    storage.putChatMessage(chatId, { message: msg('a2', 'assistant', '5') })

    const page1 = storage.getChatMessages(chatId, { limit: 2 })!
    expect((page1.messages as Msg[]).map((m) => m.id)).toEqual(['u2', 'a2'])
    expect(page1).toMatchObject({ total: 5, hasMore: true })
    const page2 = storage.getChatMessages(chatId, { limit: 2, before: page1.nextCursor })!
    expect((page2.messages as Msg[]).map((m) => m.id)).toEqual(['s1', 'a1'])
    const page3 = storage.getChatMessages(chatId, { limit: 2, before: page2.nextCursor })!
    expect((page3.messages as Msg[]).map((m) => m.id)).toEqual(['u1'])
    expect(page3.hasMore).toBe(false)
  })

  it('reads messages after the extraction watermark with their parts', () => {
    const chatId = newChat(msg('u1', 'user', 'a'), msg('a1', 'assistant', 'b', 'c'))
    const rows = storage.getChatMessagesWithIndex(chatId, { afterIndex: 0 })
    expect(rows).toEqual([{ messageIndex: 1, payload: msg('a1', 'assistant', 'b', 'c') }])
  })

  it('deletes a chat with its messages and parts', () => {
    const before = partRows()
    const chatId = newChat(msg('u1', 'user', 'a'), msg('a1', 'assistant', 'b', 'c'))
    expect(partRows()).toBe(before + 3)
    storage.deleteChatEntry(chatId)
    expect(partRows()).toBe(before)
    expect(storage.getChatEntry(chatId)).toBeUndefined()
  })

  it('refuses a message without an id', () => {
    expect(() => newChat({ id: '', role: 'user', parts: [] })).toThrow()
  })
})
