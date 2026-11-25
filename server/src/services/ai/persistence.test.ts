import fs from 'fs'
import os from 'os'
import path from 'path'
import type { UIMessage } from 'ai'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteStorage } from '../../storage/sqlite.js'
import { ChatHistoryService } from '../chat-history.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-persistence-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; see storage/chat-messages.test.ts.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

vi.mock('./state.js', () => ({
  getChatStorage: () => storage,
  getChatHistoryService: () => (storage ? new ChatHistoryService(storage) : null),
}))

const {
  beginAssistantMessage,
  createReplyWriter,
  endAssistantMessage,
  isAssistantMessageRunning,
  isSettledPart,
  persistInjectedUserMessage,
  rememberChatTurnSettings,
} = await import('./persistence.js')

type Part = UIMessage['parts'][number]

const tool = (state: string, extra: Record<string, unknown> = {}): Part =>
  ({ type: 'dynamic-tool', toolName: 't', toolCallId: 'c', input: {}, state, ...extra }) as Part

describe('isSettledPart', () => {
  it('treats finished text, reasoning and tool results as final', () => {
    expect(isSettledPart({ type: 'text', text: 'a', state: 'done' })).toBe(true)
    expect(isSettledPart({ type: 'reasoning', text: 'a', state: 'done' })).toBe(true)
    expect(isSettledPart({ type: 'step-start' })).toBe(true)
    expect(isSettledPart(tool('output-available', { output: 1 }))).toBe(true)
    expect(isSettledPart(tool('output-error', { errorText: 'x' }))).toBe(true)
    expect(isSettledPart({ ...tool('output-denied'), type: 'tool-Read' } as Part)).toBe(true)
  })

  it('keeps anything that can still change open', () => {
    expect(isSettledPart({ type: 'text', text: 'a', state: 'streaming' })).toBe(false)
    expect(isSettledPart({ type: 'text', text: 'a' })).toBe(false)
    expect(isSettledPart(tool('input-available'))).toBe(false)
    expect(isSettledPart(tool('approval-requested'))).toBe(false)
    expect(isSettledPart(tool('output-available', { output: 1, preliminary: true }))).toBe(false)
    expect(isSettledPart({ type: 'data-injected-input', id: 'x', data: {} } as Part)).toBe(false)
  })
})

describe.skipIf(!opened)('reply persistence', () => {
  let chatId: number
  const upserts: Array<{ idx: number; text: unknown }> = []

  beforeEach(() => {
    chatId = storage.createChat({
      tp: 'chat', title: 'Chat', updatedAt: 1,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] } as UIMessage],
    })
    upserts.length = 0
    // Record which part rows each save actually writes.
    const db = storage.getDatabase()
    db.function('note_part', (idx: unknown, payload: unknown) => {
      upserts.push({ idx: Number(idx), text: (JSON.parse(String(payload)) as { text?: unknown }).text })
      return null
    })
    db.exec(`DROP TRIGGER IF EXISTS note_part_insert; DROP TRIGGER IF EXISTS note_part_update;
      CREATE TEMP TRIGGER note_part_insert AFTER INSERT ON chat_message_parts BEGIN SELECT note_part(NEW.idx, NEW.payload); END;
      CREATE TEMP TRIGGER note_part_update AFTER UPDATE ON chat_message_parts BEGIN SELECT note_part(NEW.idx, NEW.payload); END;`)
  })

  const reply = (...parts: Part[]): UIMessage => ({ id: 'a1', role: 'assistant', parts })
  const stored = () => (storage.getChatEntry(chatId)!.messages as UIMessage[]).find((m) => m.id === 'a1')

  it('writes a finished part once, and rewrites only the parts still open', () => {
    const writer = createReplyWriter({ chatId })
    writer.save(reply({ type: 'text', text: 'one', state: 'done' }, { type: 'text', text: 'tw', state: 'streaming' }))
    upserts.length = 0

    writer.save(reply({ type: 'text', text: 'one', state: 'done' }, { type: 'text', text: 'two', state: 'done' }, { type: 'text', text: 'th', state: 'streaming' }))
    expect(upserts).toEqual([{ idx: 1, text: 'two' }, { idx: 2, text: 'th' }])
    upserts.length = 0

    const final = reply(
      { type: 'text', text: 'one', state: 'done' },
      { type: 'text', text: 'two', state: 'done' },
      { type: 'text', text: 'three', state: 'done' },
    )
    writer.save(final)
    expect(upserts).toEqual([{ idx: 2, text: 'three' }])
    expect(stored()).toEqual(final)
  })

  it('writes every part on a new writer\'s first save, so a continuation stores what it assembled', () => {
    createReplyWriter({ chatId }).save(reply({ type: 'text', text: 'old', state: 'done' }, tool('approval-requested')))
    upserts.length = 0

    const continued = reply({ type: 'text', text: 'as sent back', state: 'done' }, tool('output-available', { output: 1 }))
    createReplyWriter({ chatId }).save(continued)
    expect(upserts.map((u) => u.idx)).toEqual([0, 1])
    expect(stored()).toEqual(continued)
  })

  it('merges assistant metadata into the stored message', () => {
    createReplyWriter({ chatId, assistantMetadata: { source: 'cron' } }).save(reply({ type: 'text', text: 'x', state: 'done' }))
    expect(stored()?.metadata).toEqual({ source: 'cron' })
  })

  it('files a steer ahead of the newest running reply, and tracks overlapping turns', () => {
    createReplyWriter({ chatId }).save(reply({ type: 'text', text: 'partial', state: 'streaming' }))
    beginAssistantMessage(chatId, 'older')
    beginAssistantMessage(chatId, 'a1')
    persistInjectedUserMessage(chatId, { id: 's1', role: 'user', parts: [{ type: 'text', text: 'steer' }] })
    expect((storage.getChatEntry(chatId)!.messages as UIMessage[]).map((m) => m.id)).toEqual(['u1', 's1', 'a1'])

    endAssistantMessage(chatId, 'a1')
    expect(isAssistantMessageRunning(chatId)).toBe(true)
    endAssistantMessage(chatId, 'older')
    expect(isAssistantMessageRunning(chatId)).toBe(false)
  })
})

describe.skipIf(!opened)('rememberChatTurnSettings', () => {
  const agentChat = () => storage.createChat({
    tp: 'subagent', title: 'Agent: e2e', updatedAt: 1, providerId: 'codex', model: 'gpt-a', thinkingLevel: 'high',
    metadata: { modeId: 'fullAccess', externalAgent: { agentId: 'ext-1', parentChatId: 9, description: 'e2e', model: 'gpt-a' } },
  })

  it("saves a pick made in an agent's tab, keeping the rest of its metadata", () => {
    const chatId = agentChat()
    rememberChatTurnSettings(chatId, { modeId: 'requestApproval', modelId: 'gpt-b', thinkingLevel: 'max' })

    const meta = storage.getChatMeta(chatId)!
    expect(meta.metadata?.modeId).toBe('requestApproval')
    expect(meta.metadata?.externalAgent).toMatchObject({ agentId: 'ext-1' })
    expect(meta.model).toBe('gpt-b')
    expect(meta.thinkingLevel).toBe('max')
    expect(meta.providerId).toBe('codex')
  })

  it('changes only what was picked', () => {
    const chatId = agentChat()
    rememberChatTurnSettings(chatId, { thinkingLevel: 'low' })

    const meta = storage.getChatMeta(chatId)!
    expect(meta.thinkingLevel).toBe('low')
    expect(meta.model).toBe('gpt-a')
    expect(meta.metadata?.modeId).toBe('fullAccess')
  })

  it('ignores a chat that does not exist', () => {
    expect(() => rememberChatTurnSettings(999_999, { modeId: 'plan' })).not.toThrow()
  })
})
