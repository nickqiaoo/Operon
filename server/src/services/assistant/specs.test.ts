import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chats: { createChat: vi.fn(() => 40), deleteChatEntry: vi.fn(), getChatMeta: vi.fn() },
  startSpec: vi.fn(),
  answer: vi.fn(),
  sources: [] as Array<number | undefined>,
}))

vi.mock('../ai/state.js', () => ({ getChatStorage: () => mocks.chats }))
vi.mock('../workspace-assistant.js', () => ({ getOrCreateWorkspaceAssistant: () => ({ id: 2 }) }))
vi.mock('../agent-comm/task-board-service.js', () => ({
  TaskBoardService: class {
    constructor(_storage: unknown, _projectId: number, source?: number) {
      mocks.sources.push(source)
    }
    startSpec = mocks.startSpec
    answerSpecQuestions = mocks.answer
  },
}))

import type { TaskBoardStorage } from '../agent-comm/task-board-service.js'
import { createAssistantSpecs } from './specs.js'

const storage = {
  getProject: (id: number) => (id === 5 ? { id: 5 } : null),
  taskGetByNumber: (_project: number, number: number) => (number === 7 ? { id: 70, number: 7, sourceChatId: 40 } : number === 8 ? { id: 80, number: 8, sourceChatId: 41 } : null),
} as unknown as TaskBoardStorage

const start = { projectId: 5, title: 'Login', brief: 'B', providerId: 'codex', model: 'gpt-5' }

describe('createAssistantSpecs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sources.length = 0
  })

  it('gives each spec its own hidden source chat, led by the chosen agent, and puts a card in the thread', async () => {
    mocks.startSpec.mockResolvedValue({ text: 'Started.', structured: { kind: 'created-task', taskId: 70, taskNumber: 7, title: 'Login' } })
    const card = vi.fn()
    await createAssistantSpecs(storage, card).start(start)
    expect(mocks.chats.createChat).toHaveBeenCalledWith(expect.objectContaining({
      tp: 'workflow-agent', providerId: 'codex', model: 'gpt-5', metadata: { assistantSpec: { projectId: 5 } },
    }))
    expect(mocks.sources).toEqual([40])
    expect(card).toHaveBeenCalledWith({ projectId: 5, taskId: 70, taskNumber: 7, title: 'Login' })
  })

  it('leaves the model to the agent when the user accepted its default', async () => {
    mocks.startSpec.mockResolvedValue({ text: 'Started.', structured: { kind: 'created-task', taskId: 70, taskNumber: 7, title: 'Login' } })
    await createAssistantSpecs(storage, vi.fn()).start({ ...start, model: 'default' })
    expect(mocks.chats.createChat).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }))
  })

  it('removes the row and shows no card when the spec does not start', async () => {
    mocks.startSpec.mockResolvedValue({ text: 'Too few agents.', isError: true })
    const card = vi.fn()
    await expect(createAssistantSpecs(storage, card).start(start)).rejects.toThrow('Too few agents.')
    expect(mocks.chats.deleteChatEntry).toHaveBeenCalledWith(40)
    expect(card).not.toHaveBeenCalled()
  })

  it('refuses a project that is not there before creating anything', async () => {
    await expect(createAssistantSpecs(storage, vi.fn()).start({ ...start, projectId: 9 })).rejects.toThrow('There is no project 9')
    expect(mocks.chats.createChat).not.toHaveBeenCalled()
  })

  it('speaks as the source chat only for a spec the assistant started', async () => {
    mocks.chats.getChatMeta.mockImplementation((id: number) => (id === 40 ? { metadata: { assistantSpec: { projectId: 5 } } } : { metadata: {} }))
    mocks.answer.mockResolvedValue('Saved.')
    const specs = createAssistantSpecs(storage, vi.fn())
    expect(await specs.answer(5, 7, '1. yes')).toBe('Saved.')
    expect(mocks.sources).toEqual([40])
    await expect(specs.answer(5, 8, '1. yes')).rejects.toThrow('was not started here')
    await expect(specs.answer(5, 99, '1. yes')).rejects.toThrow("Task #99 is not on project 5's board")
  })
})
