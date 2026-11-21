import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { SqliteStorage } from '../storage/sqlite.js'
import { clearPendingApprovals, observePendingInputPart, resolvePendingApproval } from './ai/chat-pending-input.js'
import { initTaskNeedsInput, isAutoNeedsInput } from './task-needs-input.js'

// Run with Electron's Node, matching better-sqlite3's native ABI.
let storage: SqliteStorage
let projectId: number
let agentId: number
const CHAT_ID = 4242

beforeEach(() => {
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'Needs input', rootPath: '/tmp/needs-input' }).id
  agentId = storage.createAgent({ name: 'Worker', provider: 'codex', model: 'test-model' }).id
  initTaskNeedsInput(storage)
})
afterEach(() => {
  clearPendingApprovals(CHAT_ID)
  storage?.close()
})

function runningTask() {
  const task = storage.taskCreate({ projectId, title: 'Task', assignedAgentId: agentId })
  const binding = storage.upsertBinding({ agentId, scopeKind: 'task', scopeKey: String(task.id), projectId, status: 'active', activeChatId: CHAT_ID })
  storage.taskUpdate(task.id, { bindingId: binding.id, status: 'in_progress' }, { type: 'human', name: 'You' })
  return { task, binding }
}

function ask(approvalId: string): void {
  const part = { type: 'tool-approval-request', approvalId, toolCall: { toolName: 'AskUserQuestion', input: {} } } as unknown as RuntimeStreamPart
  observePendingInputPart(CHAT_ID, part, { userFacing: false })
}

describe('task needs input', () => {
  it('moves a running task to needs_input while its session waits, and back once answered', () => {
    const { task } = runningTask()
    ask('a1')
    ask('a2')
    expect(storage.taskGet(task.id)?.status).toBe('needs_input')
    expect(isAutoNeedsInput(storage, task.id)).toBe(true)
    resolvePendingApproval(CHAT_ID, 'a1')
    expect(storage.taskGet(task.id)?.status).toBe('needs_input')
    resolvePendingApproval(CHAT_ID, 'a2')
    expect(storage.taskGet(task.id)?.status).toBe('in_progress')
  })

  it('raises a needs-you notification and settles it when the task goes back to work', () => {
    const { task } = runningTask()
    ask('a1')
    const row = () => storage.notificationList({}).find((n) => n.sourceKey === `task:${task.id}`)
    expect(row()).toMatchObject({ kind: 'task_needs_input', severity: 'action' })
    resolvePendingApproval(CHAT_ID, 'a1')
    expect(row()?.severity).toBe('info')
  })

  it('leaves a needs_input the agent set itself until its session wakes again', () => {
    const { task, binding } = runningTask()
    storage.taskUpdate(task.id, { status: 'needs_input' }, { type: 'agent', id: agentId, name: 'Worker' })
    storage.updateBinding(binding.id, { status: 'idle' })
    ask('a1')
    clearPendingApprovals(CHAT_ID)
    expect(storage.taskGet(task.id)?.status).toBe('needs_input')
    // The human replied: a new turn starts.
    storage.updateBinding(binding.id, { status: 'active' })
    expect(storage.taskGet(task.id)?.status).toBe('in_progress')
  })

  it('does not touch tasks that are not running', () => {
    const { task } = runningTask()
    storage.taskUpdate(task.id, { status: 'in_review' }, { type: 'agent', id: agentId, name: 'Worker' })
    ask('a1')
    expect(storage.taskGet(task.id)?.status).toBe('in_review')
  })

  it('puts automatic needs_input back to work after a restart, keeps the agent-set kind', () => {
    const auto = runningTask().task
    ask('a1')
    const manual = storage.taskCreate({ projectId, title: 'Manual', assignedAgentId: agentId })
    storage.taskUpdate(manual.id, { status: 'in_progress' }, { type: 'human', name: 'You' })
    storage.taskUpdate(manual.id, { status: 'needs_input' }, { type: 'agent', id: agentId, name: 'Worker' })
    initTaskNeedsInput(storage)
    expect(storage.taskGet(auto.id)?.status).toBe('in_progress')
    expect(storage.taskGet(manual.id)?.status).toBe('needs_input')
  })
})
