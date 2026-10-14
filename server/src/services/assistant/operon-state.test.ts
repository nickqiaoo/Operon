import { describe, expect, it } from 'vitest'
import type { ChatHistoryListItem, ChatMeta } from '../../types/chat.js'
import type { Project, Workspace } from '../../types/project.js'
import type { TaskListItem } from '../../types/task.js'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'
import { createOperonState, describePending, type OperonLiveState, type OperonStateStorage } from './operon-state.js'

const NOW = 1_800_000_000_000
const project: Project = { id: 1, name: 'operon', rootPath: '/src/operon', createdAt: 0, updatedAt: 0 }
const workspaces: Workspace[] = [
  { id: 10, projectId: 1, name: 'main', branchName: 'main', worktreePath: '/src/operon', createdAt: 0, updatedAt: 0 },
  { id: 11, projectId: 1, name: 'login', branchName: 'feat/login', worktreePath: '/wt/login', createdAt: 0, updatedAt: 0 },
]
const chat = (id: number, title: string, minutesAgo: number, tp: ChatHistoryListItem['tp'] = 'chat'): ChatHistoryListItem => ({
  id, tp, title, updatedAt: NOW - minutesAgo * 60_000, providerId: 'codex', model: 'gpt-5.5',
})
const chats: Record<number, ChatHistoryListItem[]> = {
  10: [chat(1, 'Fix redirect', 2), chat(2, 'Side question', 3, 'side'), chat(3, 'Refactor store', 90)],
  11: [chat(4, 'Login page', 5)],
}
const pending = (toolName: string, inputPreview?: string): PendingInputSummary => ({
  approvalId: 'a', toolName, requestedAt: NOW, userFacing: true, ...(inputPreview ? { inputPreview } : {}),
})

function storage(): OperonStateStorage {
  return {
    listProjects: () => [project],
    getProject: (id) => (id === 1 ? project : null),
    listWorkspaces: () => workspaces,
    getWorkspace: (id) => workspaces.find((w) => w.id === id) ?? null,
    listChatEntries: (q) => chats[q?.workspaceId ?? -1] ?? [],
    getChatMeta: (id) => {
      const c = Object.entries(chats).flatMap(([ws, list]) => list.map((item) => ({ ...item, ws: Number(ws) }))).find((x) => x.id === id)
      return c ? ({ revision: 1, tp: c.tp, title: c.title, workspaceId: c.ws, updatedAt: c.updatedAt } satisfies ChatMeta) : undefined
    },
    getChatMessages: (id) =>
      id === 1
        ? { total: 1, hasMore: false, messages: [
            { id: 'q', role: 'assistant', parts: [{ type: 'tool-AskUserQuestion', toolCallId: 't', state: 'input-available', input: {} }] },
          ] }
        : id === 3
        ? { total: 2, hasMore: false, messages: [
            { id: 'u', role: 'user', parts: [{ type: 'text', text: 'go' }] },
            { id: 'r', role: 'assistant', parts: [{ type: 'text', text: 'Moved the store\n into   slices.' }] },
          ] }
        : { total: 0, hasMore: false, messages: [] },
    taskList: () => [
      { number: 7, title: 'Ship login', status: 'in_review', workspaceId: 11 },
      { number: 8, title: 'Old thing', status: 'done', workspaceId: null },
    ] as TaskListItem[],
  }
}

function live(overrides: Partial<OperonLiveState> = {}): OperonLiveState {
  return {
    isBusy: (id) => id === 1 || id === 4,
    pending: (id) => (id === 4 ? [pending('Bash', 'pnpm install')] : []),
    awaiting: () => [{ chatId: 4, pending: [pending('Bash', 'pnpm install')] }],
    diffStat: async (path): ReturnType<OperonLiveState['diffStat']> =>
      path === '/wt/login' ? { 'a.ts': { additions: 10, deletions: 2 }, 'b.ts': { additions: 5, deletions: 0 } } : {},
    ...overrides,
  }
}

describe('describePending', () => {
  it('reads the question out of a clipped AskUserQuestion preview', () => {
    const preview = '{"questions":[{"question":"除数为 0 时，是抛错还是返回 \\"Infinity\\"？","header":"除零","options":[{"label":"抛'
    expect(describePending(pending('AskUserQuestion', preview))).toBe('"除数为 0 时，是抛错还是返回 \"Infinity\"？"')
    expect(describePending(pending('AskUserQuestion'))).toBe('a question')
    expect(describePending(pending('Bash', 'rm -rf  build'))).toBe('Bash (rm -rf build)')
  })
})

describe('createOperonState', () => {
  it('lists workspaces with what is running and what waits on the user — waiting is not also counted as running', () => {
    const text = createOperonState(storage(), live(), () => NOW).workspaceList()
    expect(text).toContain('Project 1 "operon" — /src/operon')
    expect(text).toContain('workspace 10 "main" · branch main · /src/operon · 1 running')
    expect(text).toContain('workspace 11 "login" · branch feat/login · /wt/login · 1 waiting for the user')
  })

  it('details a workspace: changes, conversations with state, last reply of idle ones, open tasks', async () => {
    const state = createOperonState(storage(), live(), () => NOW)
    const main = await state.workspaceOverview(10)
    expect(main).toContain('Uncommitted changes: none')
    expect(main).toContain('chat 1 · codex / gpt-5.5 · running · "Fix redirect" · updated 2m ago')
    expect(main).toContain('chat 3 · codex / gpt-5.5 · idle · "Refactor store" · updated 2h ago\n  last reply: Moved the store into slices.')
    expect(main).not.toContain('Side question')
    expect(await createOperonState(storage(), live({ isBusy: () => false }), () => NOW).workspaceOverview(10))
      .toContain('"Fix redirect" · updated 2m ago\n  last reply: (no text; its last turn ended on AskUserQuestion)')
    expect(main).toContain('- #7 [in_review] Ship login')
    expect(main).not.toContain('Old thing')

    const login = await state.workspaceOverview(11)
    expect(login).toContain('Uncommitted changes: 2 files, +15 −2')
    expect(login).toContain('waiting for the user: Bash (pnpm install)')
    expect(login).toContain('- #7 [in_review] Ship login · this workspace')
  })

  it('says so when the worktree cannot be read or the workspace does not exist', async () => {
    const state = createOperonState(storage(), live({ diffStat: async () => { throw new Error('gone') } }), () => NOW)
    expect(await state.workspaceOverview(10)).toContain('could not read the worktree')
    expect(await state.workspaceOverview(99)).toBe('There is no workspace 99. Call workspace_list for the ids.')
  })

  it('lists what waits on the user, with where it is', () => {
    const state = createOperonState(storage(), live(), () => NOW)
    expect(state.waitingList()).toBe('- chat 4 "Login page" (workspace 11 "login" in project "operon") · Bash (pnpm install)')
    expect(createOperonState(storage(), live({ awaiting: () => [] })).waitingList()).toBe('Nothing is waiting for the user.')
  })
})
