import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'
import { onTaskEvent, type TaskEvent } from '../services/channel-bus.js'

// Run with Electron's Node, matching better-sqlite3's native ABI.
let storage: SqliteStorage
let projectId: number
let agentId: number
beforeEach(() => {
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'Runtime test', rootPath: '/tmp/runtime-test' }).id
  agentId = storage.createAgent({ name: 'Spec coordinator', provider: 'codex', model: 'test-model', hidden: true }).id
})
afterEach(() => storage?.close())

function taskWithBinding(title: string, parentTaskId?: number) {
  const task = storage.taskCreate({ projectId, title, assignedAgentId: agentId, parentTaskId })
  const binding = storage.upsertBinding({ agentId, scopeKind: 'task', scopeKey: String(task.id), projectId, status: 'idle' })
  storage.taskUpdate(task.id, { bindingId: binding.id, status: 'in_progress' })
  return { task, binding }
}

describe('task execution on the live board', () => {
  it('keeps two tasks using the same hidden agent independent and resolves its identity', () => {
    const first = taskWithBinding('First')
    const second = taskWithBinding('Second')
    storage.updateBinding(first.binding.id, { status: 'active' })
    const tasks = storage.taskList({ projectId })
    expect(tasks.find((t) => t.id === first.task.id)).toMatchObject({ executionStatus: 'active', assignedAgent: { id: agentId, provider: 'codex' }, executionAgent: { id: agentId } })
    expect(tasks.find((t) => t.id === second.task.id)?.executionStatus).toBe('idle')
  })

  it('pushes both start and finish transitions without changing the task status', () => {
    const { task, binding } = taskWithBinding('Live')
    const events: TaskEvent[] = []
    const unsub = onTaskEvent(projectId, (event) => events.push(event))
    try {
      storage.updateBinding(binding.id, { status: 'active' })
      storage.updateBinding(binding.id, { status: 'idle' })
    } finally { unsub() }
    expect(events.map((e) => e.task.executionStatus)).toEqual(['active', 'idle'])
    expect(events.every((e) => e.task.status === 'in_progress' && e.task.id === task.id)).toBe(true)
  })

  it('shows an active ticket on its Spec while the coordinator is idle, then clears it', () => {
    const parent = taskWithBinding('Spec')
    storage.specRunCreate({ taskId: parent.task.id, stage: 'building', config: {
      lead: { providerId: 'codex' }, explorer: { providerId: 'codex' }, candidates: [{ providerId: 'codex' }], judge: { providerId: 'codex' }, builder: { providerId: 'codex' },
    } })
    const child = taskWithBinding('Ticket', parent.task.id)
    const events: TaskEvent[] = []
    const unsub = onTaskEvent(projectId, (event) => events.push(event))
    try {
      storage.updateBinding(child.binding.id, { status: 'active' })
      expect(storage.taskDetail(parent.task.id)?.executionStatus).toBe('active')
      storage.updateBinding(child.binding.id, { status: 'idle' })
      expect(storage.taskDetail(parent.task.id)?.executionStatus).toBe('idle')
    } finally { unsub() }
    expect(events.filter((e) => e.task.id === parent.task.id).map((e) => e.task.executionStatus)).toEqual(['active', 'idle'])
  })

  it('ignores updates from a replaced session', () => {
    const { task, binding } = taskWithBinding('Reassigned')
    const nextAgent = storage.createAgent({ name: 'Replacement', provider: 'cursor', model: '' })
    const next = storage.upsertBinding({ agentId: nextAgent.id, scopeKind: 'task', scopeKey: String(task.id), projectId, status: 'idle' })
    storage.taskUpdate(task.id, { bindingId: next.id, assignedAgentId: nextAgent.id })
    storage.updateBinding(binding.id, { status: 'active' })
    expect(storage.taskGet(task.id)).toMatchObject({ executionStatus: 'idle', assignedAgent: { id: nextAgent.id } })
  })
  it('repairs a Spec assignee on startup and keeps a replacement coordinator in sync without dispatching', async () => {
    const { initOrchestrator, attachSpecCoordinator } = await import('../services/channel/agent-orchestrator.js')
    const { task, binding } = taskWithBinding('Existing Spec')
    const workspace = storage.createWorkspace(projectId, { name: 'Spec', branchName: 'spec', worktreePath: '/tmp/runtime-test/spec' })
    storage.specRunCreate({ taskId: task.id, stage: 'building', config: {
      lead: { providerId: 'codex' }, explorer: { providerId: 'codex' }, candidates: [{ providerId: 'codex' }], judge: { providerId: 'codex' }, builder: { providerId: 'codex' },
    } })
    storage.taskUpdate(task.id, { workspaceId: workspace.id, assignedAgentId: null })
    initOrchestrator(storage)
    expect(storage.taskGet(task.id)?.assignedAgentId).toBe(agentId)
    expect(storage.getBinding(binding.id)?.status).toBe('idle')
    const next = storage.createAgent({ name: 'New coordinator', provider: 'cursor', model: '', hidden: true })
    const replacement = attachSpecCoordinator(task.id, next.id)
    expect(storage.taskGet(task.id)).toMatchObject({ assignedAgentId: next.id, bindingId: replacement?.id, assignedAgent: { provider: 'cursor' } })
    expect(replacement?.status).toBe('offline')
  })

  it('streams a fresh snapshot on connection and a stop event to the board', async () => {
    const { taskRoutes } = await import('../routes/task.js')
    const { binding } = taskWithBinding('Streamed task')
    storage.updateBinding(binding.id, { status: 'active' })
    const routes = taskRoutes(storage)
    const response = await routes.request(`/stream?projectId=${projectId}`)
    const reader = response.body!.getReader()
    const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)
    try {
      expect(decode((await reader.read()).value)).toContain('"executionStatus":"active"')
      storage.updateBinding(binding.id, { status: 'idle' })
      expect(decode((await reader.read()).value)).toContain('"executionStatus":"idle"')
    } finally { await reader.cancel() }
  })

})
