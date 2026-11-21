import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const orchestrator = vi.hoisted(() => ({
  dispatchProjectTask: vi.fn(async (_taskId: number, _agentId: number): Promise<void> => undefined),
  wakeTaskBinding: vi.fn(async (_bindingId: number, _message: string): Promise<boolean> => true),
}))
vi.mock('../services/channel/agent-orchestrator.js', () => orchestrator)

import { SqliteStorage } from './sqlite.js'
import {
  SubtaskProposalError,
  confirmSubtaskProposal,
  dismissSubtaskProposal,
  initSubtaskReports,
  proposeSubtasks,
} from '../services/task-subtasks.js'
import type { SubtaskProposalMeta, Task } from '../types/task.js'

// Run under Electron's Node to match the native SQLite ABI.
let storage: SqliteStorage
let projectId: number
let lead: number
let builder: number
let parent: Task

beforeEach(() => {
  orchestrator.dispatchProjectTask.mockClear()
  orchestrator.wakeTaskBinding.mockClear()
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'Subtasks', rootPath: '/tmp/subtasks-test' }).id
  lead = storage.createAgent({ name: 'lead', provider: 'claude', model: 'm' }).id
  builder = storage.createAgent({ name: 'builder', provider: 'codex', model: 'm' }).id
  const task = storage.taskCreate({ projectId, title: 'Parent', assignedAgentId: lead })
  const binding = storage.upsertBinding({ agentId: lead, scopeKind: 'task', scopeKey: String(task.id), projectId, status: 'idle' })
  parent = storage.taskUpdate(task.id, { bindingId: binding.id, status: 'in_progress' })!
})
afterEach(() => storage?.close())

const proposalOf = (activityId: number) => storage.taskGetActivity(parent.id, activityId)!.meta as unknown as SubtaskProposalMeta

describe('sub-task proposals', () => {
  it('records what the agent was told and leaves the rest to the person', () => {
    expect(() => proposeSubtasks(storage, parent, builder, 'builder', [{ title: 'x', description: '' }])).toThrow(SubtaskProposalError)

    const { activity, unknownAssignees } = proposeSubtasks(storage, parent, lead, 'lead', [
      { title: 'API', description: 'Build the API', assignee: '@builder', workspace: 'new' },
      { title: 'Docs', description: 'Write docs', assignee: 'nobody' },
    ])
    expect(unknownAssignees).toEqual(['nobody'])
    expect(proposalOf(activity.id)).toMatchObject({
      state: 'pending',
      items: [
        { title: 'API', assignedAgentId: builder, workspaceMode: 'new' },
        { title: 'Docs', assignedAgentId: null, workspaceMode: null },
      ],
    })
    expect(storage.taskGet(parent.id)?.status).toBe('needs_input')
    // One open proposal at a time.
    expect(() => proposeSubtasks(storage, storage.taskGet(parent.id)!, lead, 'lead', [{ title: 'y', description: '' }])).toThrow(/already has a proposal/)
  })

  it('creates and dispatches each confirmed item where the person said, then tells the agent', async () => {
    const { activity } = proposeSubtasks(storage, parent, lead, 'lead', [{ title: 'API', description: 'Build it' }])
    const results = await confirmSubtaskProposal(storage, parent, activity.id, [
      { title: 'API', description: 'Build it', assignedAgentId: builder, workspaceMode: 'shared' },
      { title: 'Tests', description: '', assignedAgentId: lead, workspaceMode: 'new' },
    ], 'You')

    const children = storage.taskListChildren(parent.id)
    expect(children.map((c) => [c.title, c.assignedAgentId, c.workspaceMode])).toEqual([
      ['API', builder, 'shared'],
      ['Tests', lead, 'new'],
    ])
    expect(orchestrator.dispatchProjectTask.mock.calls.map((call) => call[0])).toEqual(children.map((c) => c.id))
    expect(proposalOf(activity.id)).toMatchObject({ state: 'confirmed', items: results })
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(parent.bindingId, expect.stringContaining('shared workspace'))
    await expect(confirmSubtaskProposal(storage, parent, activity.id, results.map((r) => ({
      title: r.title, description: r.description, assignedAgentId: r.assignedAgentId!, workspaceMode: r.workspaceMode!,
    })), 'You')).rejects.toThrow(/already confirmed/)
  })

  it('dismisses without creating anything', () => {
    const { activity } = proposeSubtasks(storage, parent, lead, 'lead', [{ title: 'API', description: '' }])
    dismissSubtaskProposal(storage, parent, activity.id, 'You')
    expect(proposalOf(activity.id).state).toBe('dismissed')
    expect(storage.taskListChildren(parent.id)).toEqual([])
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(parent.bindingId, expect.stringContaining('dismissed'))
  })

  it('reports a sub-task reaching review to its parent', () => {
    initSubtaskReports(storage)
    const child = storage.taskCreate({ projectId, title: 'Child', parentTaskId: parent.id, assignedAgentId: builder })
    storage.taskUpdate(child.id, { status: 'in_progress' })
    expect(orchestrator.wakeTaskBinding).not.toHaveBeenCalled()
    storage.taskAppendActivity(child.id, { kind: 'comment', actorType: 'agent', actorName: 'builder', body: 'Done: added the endpoint' })
    storage.taskUpdate(child.id, { status: 'in_review' })
    expect(orchestrator.wakeTaskBinding).toHaveBeenCalledWith(parent.bindingId, expect.stringContaining('added the endpoint'))
    expect(storage.taskListActivity(parent.id).at(-1)?.meta).toMatchObject({ event: 'subtask.status', to: 'in_review' })
    // Done by a person: recorded on the parent, the agent is not woken for it.
    orchestrator.wakeTaskBinding.mockClear()
    storage.taskUpdate(child.id, { status: 'done' }, { type: 'human', name: 'You' })
    expect(orchestrator.wakeTaskBinding).not.toHaveBeenCalled()
    expect(storage.taskListActivity(parent.id).at(-1)?.meta).toMatchObject({ event: 'subtask.status', to: 'done' })
  })
})

describe('shared workspace mode', () => {
  it('is stored on the task, and a shared task does not own its workspace', () => {
    const ws = storage.createWorkspace(projectId, { name: 'main', branchName: 'main', worktreePath: '/tmp/subtasks-test' })
    const shared = storage.taskCreate({ projectId, title: 'Shared', workspaceMode: 'shared' })
    expect(shared.workspaceMode).toBe('shared')
    storage.taskUpdate(shared.id, { workspaceId: ws.id })
    expect(storage.taskGetByWorkspace(ws.id)).toBeNull()
    expect(storage.taskCreate({ projectId, title: 'Own' }).workspaceMode).toBe('new')
  })
})

describe('sub-task sessions in the project tree', () => {
  it('lists a sub-task session under its parent task session, and files its worktree under that chat', async () => {
    const { projectRoutes } = await import('../routes/project.js')
    const parentChat = storage.createChat({ tp: 'chat', title: 'Parent session', providerId: 'claude', updatedAt: 1 })
    storage.updateBinding(parent.bindingId!, { activeChatId: parentChat })
    const child = storage.taskCreate({ projectId, title: 'API', parentTaskId: parent.id, assignedAgentId: builder })
    const ws = storage.createWorkspace(projectId, { name: 'builder · task #2', branchName: 'operon/2', worktreePath: '/tmp/subtasks-test-2' })
    storage.setWorkspaceOriginChat(ws.id, parentChat)
    const childChat = storage.createChat({ tp: 'chat', title: 'Child session', providerId: 'codex', workspaceId: ws.id, updatedAt: 2 })
    const binding = storage.upsertBinding({ agentId: builder, scopeKind: 'task', scopeKey: String(child.id), projectId, status: 'idle' })
    storage.updateBinding(binding.id, { activeChatId: childChat })
    storage.taskUpdate(child.id, { bindingId: binding.id, workspaceId: ws.id, status: 'in_progress' })

    const res = await projectRoutes(storage).request('/?include=workspaces')
    const { projects } = (await res.json()) as { projects: Array<{ id: number; taskChildren: unknown[]; workspaces: Array<{ id: number; originChatId: number | null }> }> }
    const project = projects.find((p) => p.id === projectId)!
    expect(project.taskChildren).toEqual([expect.objectContaining({ taskId: child.id, parentChatId: parentChat, chatId: childChat, workspaceId: ws.id, status: 'in_progress' })])
    expect(project.workspaces.find((w) => w.id === ws.id)?.originChatId).toBe(parentChat)
  })
})
