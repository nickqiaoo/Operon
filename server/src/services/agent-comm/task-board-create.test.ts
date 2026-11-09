import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../task-events.js', () => ({ broadcastTask: vi.fn() }))
vi.mock('../notification-service.js', () => ({ notifyTaskStatusChange: vi.fn() }))
vi.mock('../../gateway/surfaces/surface-sync.js', () => ({ mirrorAgentComment: vi.fn() }))
vi.mock('../../gateway/surfaces/pull-request-tool.js', () => ({ submitPullRequest: vi.fn() }))
vi.mock('../channel/agent-orchestrator.js', () => ({ maybeAutoDispatchTask: vi.fn(async () => {}), maybeAutoIntegrate: vi.fn() }))
vi.mock('../ai/state.js', () => ({ getChatStorage: () => null }))
vi.mock('../ai/providers.js', () => ({ getProviders: () => [] }))
vi.mock('../spec/build-run.js', () => ({ isReviewedTicket: () => false }))
vi.mock('../spec/spec-service.js', () => ({ SpecError: class extends Error {}, answerSpecQuestions: vi.fn(), startSpec: vi.fn() }))
vi.mock('../spec/switch.js', () => ({ dismissSwitchProposal: vi.fn(), proposeSwitch: vi.fn(), switchSpecSeat: vi.fn() }))
vi.mock('../spec/coordinator.js', () => ({}))

import { TaskBoardService, type TaskBoardStorage } from './task-board-service.js'

const taskCreate = vi.fn((input: { title: string }) => ({ id: 71, number: 8, title: input.title }))
const storage = {
  taskCreate,
  getAgent: () => ({ id: 2, name: 'Workspace Assistant' }),
  listAgents: () => [
    { name: 'builder', provider: 'codex', model: 'gpt-5', hidden: false },
    { name: 'Workspace Assistant', provider: 'codex', model: 'gpt-5', hidden: true },
  ],
} as unknown as TaskBoardStorage

describe('the board from a chat', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a plain task from a direct chat, with what the transcript card needs', () => {
    const result = new TaskBoardService(storage, 5, 40).createTask({ title: ' Add divide ', description: 'Details', priority: 2 }, 2)
    expect(taskCreate).toHaveBeenCalledWith({
      projectId: 5, title: 'Add divide', description: 'Details', priority: 2, createdBy: 'agent', actorId: 2, actorName: 'Workspace Assistant',
    })
    expect(result.structured).toEqual({ kind: 'created-task', taskId: 71, taskNumber: 8, title: 'Add divide' })
  })

  it('refuses a channel session, and an empty title', () => {
    expect(new TaskBoardService(storage, 5).createTask({ title: 'x' }, 2).isError).toBe(true)
    expect(new TaskBoardService(storage, 5, 40).createTask({ title: '  ' }, 2).isError).toBe(true)
    expect(taskCreate).not.toHaveBeenCalled()
  })

  it('lists only the agents a person could pick', () => {
    expect(new TaskBoardService(storage, 5, 40).listAgents()).toBe('- @builder — codex, gpt-5')
  })
})
