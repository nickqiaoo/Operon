import { describe, expect, it, vi } from 'vitest'
import type { Activity } from '../../../../shared/assistant.js'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'
import { CodingAgents, type CodingHost } from './coding.js'
import { callAssistantTool, type AssistantToolHost } from './tools.js'

function setup(overrides: Partial<CodingHost> = {}) {
  const activities = new Map<string, Activity>()
  const owners = new Map<number, string>()
  const told: Array<{ text: string; activityId?: string }> = []
  const cards: string[] = []
  const host: CodingHost = {
    workspace: (id) =>
      id === 6
        ? {
            workspace: { id: 6, projectId: 5, name: 'main', branchName: 'main', worktreePath: '/src/xui', createdAt: 0, updatedAt: 0 },
            project: { id: 5, name: 'xui', rootPath: '/src/xui', createdAt: 0, updatedAt: 0 },
          }
        : undefined,
    create: vi.fn(async ({ activityId }) => {
      owners.set(42, activityId)
      return { chatId: 42 }
    }),
    activityOf: (chatId) => owners.get(chatId),
    send: vi.fn(),
    stop: vi.fn(() => true),
    status: (chatId) => ({ chatId, status: 'running' }),
    diffStat: async () => ({ 'a.ts': { additions: 12, deletions: 3 }, 'b.ts': { additions: 1, deletions: 0 } }),
    activity: (id) => activities.get(id),
    save: (a) => void activities.set(a.id, a),
    card: (id) => void cards.push(id),
    tell: (text, cause) => void told.push({ text, ...('activityId' in cause ? { activityId: cause.activityId } : {}) }),
    now: () => 1000,
    ...overrides,
  }
  let n = 0
  const coding = new CodingAgents(host, () => `act-${++n}`)
  return { coding, host, activities, told, cards }
}

const start = (coding: CodingAgents) =>
  coding.start({ workspaceId: 6, title: 'Fix login', prompt: 'Fix it', providerId: 'codex', model: 'gpt-5.5' })

const pending = (toolName: string, inputPreview?: string): PendingInputSummary => ({
  approvalId: 'p', toolName, requestedAt: 0, userFacing: true, ...(inputPreview ? { inputPreview } : {}),
})

describe('CodingAgents', () => {
  it('starts a conversation in the workspace and records it as a running coding activity with a card', async () => {
    const t = setup()
    const activity = await start(t.coding)
    expect(t.host.create).toHaveBeenCalledWith({ activityId: 'act-1', workspaceId: 6, title: 'Fix login', prompt: 'Fix it', providerId: 'codex', model: 'gpt-5.5' })
    expect(activity).toMatchObject({
      id: 'act-1', taskId: 'ac-42', agent: 'coding', status: 'running', title: 'Fix login',
      coding: { chatId: 42, workspaceId: 6, workspaceName: 'main', projectName: 'xui', branch: 'main', providerId: 'codex', model: 'gpt-5.5' },
    })
    expect(t.cards).toEqual(['act-1'])
  })

  it('refuses a workspace that does not exist, before opening anything', async () => {
    const t = setup()
    await expect(t.coding.start({ workspaceId: 99, title: 't', prompt: 'p', providerId: 'codex', model: 'default' })).rejects.toThrow('There is no workspace 99')
    expect(t.host.create).not.toHaveBeenCalled()
  })

  it('finishes with the result, the changes left in the worktree, and a notice for the main agent', async () => {
    const t = setup()
    await start(t.coding)
    await t.coding.turnEnded({ chatId: 42, status: 'completed', dispatched: true, result: '## **Fixed** `login.ts`\nThe redirect works.' })
    expect(t.activities.get('act-1')).toMatchObject({
      status: 'done', summary: 'Fixed login.ts', report: '## **Fixed** `login.ts`\nThe redirect works.', finishedAt: 1000,
      coding: { diffStat: { files: 2, additions: 13, deletions: 3 } },
    })
    expect(t.told).toHaveLength(1)
    expect(t.told[0]!.activityId).toBe('act-1')
    expect(t.told[0]!.text).toContain('[Coding agent finished] "Fix login" — project "xui", workspace "main" — completed.')
    expect(t.told[0]!.text).toContain('2 files, +13 −3')
    expect(t.told[0]!.text).toContain('The redirect works.')
  })

  it('updates the card but stays quiet for a turn the user drove from the conversation, or one that was stopped', async () => {
    const t = setup()
    await start(t.coding)
    await t.coding.turnEnded({ chatId: 42, status: 'completed', dispatched: false, result: 'ok' })
    await t.coding.turnEnded({ chatId: 42, status: 'cancelled', dispatched: true, result: '' })
    expect(t.activities.get('act-1')!.status).toBe('stopped')
    expect(t.told).toEqual([])
  })

  it('ignores conversations it did not start', async () => {
    const t = setup()
    await t.coding.turnEnded({ chatId: 7, status: 'completed', dispatched: true, result: 'x' })
    t.coding.pendingChanged(7, [pending('Bash')], true)
    expect(t.told).toEqual([])
    expect(() => t.coding.send(7, 'more')).toThrow('not one you started')
    expect(t.host.send).not.toHaveBeenCalled()
  })

  it('shows what the conversation waits on, tells the main agent once, and goes back to running when answered', async () => {
    const t = setup()
    await start(t.coding)
    t.coding.pendingChanged(42, [pending('Bash', 'pnpm install')], true)
    t.coding.pendingChanged(42, [pending('Bash', 'pnpm install'), pending('AskUserQuestion')], false)
    expect(t.activities.get('act-1')).toMatchObject({
      status: 'waiting',
      summary: 'Waiting for you: Bash (pnpm install); a question',
      coding: { waitingFor: 'Bash (pnpm install); a question' },
    })
    expect(t.told).toHaveLength(1)
    expect(t.told[0]!.text).toContain('[Coding agent waiting] "Fix login"')
    expect(t.told[0]!.text).toContain('Bash (pnpm install)')

    t.coding.pendingChanged(42, [], false)
    expect(t.activities.get('act-1')!.status).toBe('running')
    expect(t.activities.get('act-1')!.coding!.waitingFor).toBeUndefined()
    expect(t.activities.get('act-1')!.coding!.pending).toBeUndefined()
  })

  it('carries the requests themselves, so the card can answer them in place', async () => {
    const t = setup()
    await start(t.coding)
    const questions = [{ question: 'Throw or Infinity?', options: [{ label: 'Throw' }, { label: 'Infinity' }] }]
    t.coding.pendingChanged(42, [{ ...pending('AskUserQuestion'), approvalId: 'q1', toolInput: { questions } }, pending('Bash', 'pnpm i')], true)
    expect(t.activities.get('act-1')!.coding!.pending).toEqual([
      { approvalId: 'q1', toolName: 'AskUserQuestion', input: { questions } },
      { approvalId: 'p', toolName: 'Bash', preview: 'pnpm i' },
    ])
    expect(t.told[0]!.text).toContain('right on its card in this thread')
    await t.coding.turnEnded({ chatId: 42, status: 'completed', dispatched: true, result: 'done' })
    expect(t.activities.get('act-1')!.coding!.pending).toBeUndefined()
  })

  it('a follow-up re-opens a finished card as running', async () => {
    const t = setup()
    await start(t.coding)
    await t.coding.turnEnded({ chatId: 42, status: 'completed', dispatched: true, result: 'done' })
    t.coding.send(42, 'also add tests')
    expect(t.host.send).toHaveBeenCalledWith(42, 'also add tests')
    expect(t.activities.get('act-1')).toMatchObject({ status: 'running' })
    expect(t.activities.get('act-1')!.finishedAt).toBeUndefined()
    expect(t.coding.chatOf('act-1')).toBe(42)
    // From the drawer: no new card.
    expect(t.cards).toEqual(['act-1'])
  })

  it('more work from the assistant puts the card down again, renamed when it is a new piece of work', async () => {
    const t = setup()
    await start(t.coding)
    t.coding.send(42, 'now add divide', { title: 'Add divide' })
    expect(t.cards).toEqual(['act-1', 'act-1'])
    expect(t.activities.get('act-1')!.title).toBe('Add divide')
    t.coding.send(42, 'and a test', {})
    expect(t.activities.get('act-1')!.title).toBe('Add divide')
  })
})

describe('coding_start', () => {
  const host = (start: AssistantToolHost['coding']['start']) =>
    ({ coding: { start, models: vi.fn(), send: vi.fn(), status: vi.fn(), stop: vi.fn() } }) as unknown as AssistantToolHost
  const args = { workspace_id: 6, title: 'Fix login', prompt: 'Fix it', agent: 'codex', model: 'gpt-5.5' }

  it('will not start before the user chose the agent and the model', async () => {
    const start = vi.fn(async () => 'Started')
    const result = await callAssistantTool('coding_start', { ...args, selection_confirmed: false }, { role: 'main' }, host(start))
    expect(result).toMatchObject({ isError: true })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts once they have, and passes errors back to the model', async () => {
    const start = vi.fn(async () => 'Started')
    expect(await callAssistantTool('coding_start', { ...args, selection_confirmed: true }, { role: 'main' }, host(start))).toEqual({ text: 'Started' })
    expect(start).toHaveBeenCalledWith({ workspaceId: 6, title: 'Fix login', prompt: 'Fix it', providerId: 'codex', model: 'gpt-5.5' })
    const failing = vi.fn(async () => {
      throw new Error('Available agents: codex')
    })
    expect(await callAssistantTool('coding_start', { ...args, selection_confirmed: true }, { role: 'main' }, host(failing))).toEqual({
      text: 'Available agents: codex',
      isError: true,
    })
  })

  it('is the main agent’s alone', async () => {
    const start = vi.fn(async () => 'Started')
    expect(await callAssistantTool('coding_start', { ...args, selection_confirmed: true }, { role: 'worker', id: 'w1' }, host(start))).toMatchObject({ isError: true })
  })
})
