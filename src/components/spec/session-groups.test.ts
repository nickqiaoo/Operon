import { describe, expect, it } from 'vitest'
import type { SpecChatRef, SpecView } from '@shared/spec'
import { groupSpecSessions, listSpecSessions } from './session-groups'

const chat = (chatId: number, updatedAt = chatId): SpecChatRef => ({
  chatId, title: `Chat ${chatId}`, providerId: 'codex', workspaceId: null, subAgent: true, updatedAt,
})
const agent = (phase: string, conversation: SpecChatRef): SpecView['agents'][number] => ({
  runId: 'run', index: conversation.chatId, label: conversation.title, phase, state: 'done', chats: [conversation],
})
const ticket = { key: 'T1', title: 'Implement navigation', delivers: '', acceptance: [], blockedBy: [], interfaces: [] }
const task = (chats: SpecChatRef[]): SpecView['ticketTasks'][string] => ({
  id: 1, number: 1, status: 'done', workspaceId: null, chats,
})

describe('Spec session order', () => {
  it('puts implementation before its review even when the implementation was updated later', () => {
    const result = groupSpecSessions({
      agents: [agent('Tickets', chat(5)), agent('Build', chat(20)), agent('Review', chat(30))],
      tickets: [ticket], ticketTasks: { T1: task([chat(10, 1000)]) },
    })
    expect(result.phases.map((p) => p.title)).toEqual(['Tickets', 'Build', 'Review'])
    expect(result.phases[1].rows.map((r) => r.chat.chatId)).toEqual([10, 20])
  })

  it('shows a builder conversation only once when the Workflow also records it', () => {
    const result = groupSpecSessions({ agents: [agent('Build', chat(10))], tickets: [ticket], ticketTasks: { T1: task([chat(10)]) } })
    expect(result.phases[0].rows).toHaveLength(1)
    expect(result.phases[0].rows[0].label).toBe('T1 · Implement navigation')
  })

  it('creates Build before whole-change Review for older runs without builder records', () => {
    const result = groupSpecSessions({ agents: [agent('Review', chat(30))], tickets: [ticket], ticketTasks: { T1: task([chat(10)]) } })
    expect(result.phases.map((p) => p.title)).toEqual(['Build', 'Review'])
  })
})


describe('Complete Spec session list', () => {
  it('includes ticket chats even when the ticket document is unavailable', () => {
    const result = listSpecSessions({ sourceChat: chat(1), coordinator: null, agents: [agent('Review', chat(30))], tickets: null, ticketTasks: { T1: task([chat(10)]) } })
    expect(result.map((row) => row.chat.chatId)).toEqual([1, 10, 30])
  })

  it('deduplicates source, agent and ticket conversations by id', () => {
    const result = listSpecSessions({ sourceChat: chat(10), coordinator: null, agents: [agent('Build', chat(10)), agent('Review', chat(30))], tickets: [ticket], ticketTasks: { T1: task([chat(10), chat(20)]) } })
    expect(result.map((row) => row.chat.chatId)).toEqual([10, 20, 30])
  })
})
