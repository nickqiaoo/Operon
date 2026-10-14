import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../types/task.js'

const human = vi.hoisted(() => ({
  update: vi.fn(),
  comment: vi.fn(),
  provision: vi.fn(),
  broadcast: vi.fn(),
  isGitRepo: vi.fn(async () => true),
  worktreeList: vi.fn(async () => [] as unknown[]),
  ghStatus: vi.fn(async () => ({ isInstalled: true, isAuthenticated: true })),
  ghPrList: vi.fn(),
  ghPrCreate: vi.fn(),
  prepare: vi.fn(),
}))
vi.mock('../git.js', () => ({ isGitRepo: human.isGitRepo, worktreeList: human.worktreeList, getDefaultBaseBranch: async () => 'main' }))
vi.mock('../integrations/gh-cli.js', () => ({ getGhStatus: human.ghStatus, ghPrList: human.ghPrList, ghPrView: vi.fn(), ghPrCreate: human.ghPrCreate }))
vi.mock('../integrations/github-pr.js', () => ({ prepareBranchForPr: human.prepare }))
vi.mock('../task-human-actions.js', () => ({ updateTaskAsHuman: human.update, commentOnTaskAsHuman: human.comment }))
vi.mock('../workspace-provision.js', () => ({ provisionWorkspace: human.provision }))
vi.mock('../task-events.js', () => ({ broadcastTask: human.broadcast }))

import { createOperonActions, type OperonActionsStorage } from './operon-actions.js'

const task = { id: 70, projectId: 5, number: 7, title: 'Ship login', status: 'in_review' } as Task

function storage() {
  return {
    listProjects: () => [{ id: 5, name: 'xui', rootPath: '/src/xui', createdAt: 0, updatedAt: 0 }],
    createProject: vi.fn((input: { name: string; rootPath: string }) => ({ id: 9, ...input })),
    createWorkspace: vi.fn((projectId: number, input: { name: string }) => ({ id: 90, projectId, ...input })),
    getWorkspace: (id: number) =>
      id === 6 ? { id: 6, projectId: 5, name: 'main', branchName: 'main', worktreePath: '/src/xui' }
      : id === 66 ? { id: 66, projectId: 5, name: 'login', branchName: 'login', worktreePath: '/wt/login' }
      : null,
    taskSurfaceList: () => [{ kind: 'github_pr', externalId: 'o/xui#12', url: 'https://github.com/o/xui/pull/12' }],
    getProject: (id: number) => (id === 5 ? { id: 5, name: 'xui', rootPath: '/src/xui', createdAt: 0, updatedAt: 0 } : null),
    taskGetByNumber: (projectId: number, number: number) => (projectId === 5 && number === 7 ? task : null),
    taskGet: () => ({ ...task, status: 'done' }),
    taskCreate: vi.fn((input: { title: string }) => ({ id: 71, number: 8, title: input.title })),
  } as unknown as OperonActionsStorage & { taskCreate: ReturnType<typeof vi.fn> }
}

describe('createOperonActions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses a project or task that is not there, before touching anything', async () => {
    const actions = createOperonActions(storage(), () => '小Q')
    await expect(actions.createWorkspace({ projectId: 9, name: 'x' })).rejects.toThrow('There is no project 9')
    await expect(actions.boardUpdate(5, 99, { status: 'done' })).rejects.toThrow("Task #99 is not on project 5's board")
    expect(() => actions.boardComment(9, 7, 'hi')).toThrow('There is no project 9')
    expect(human.provision).not.toHaveBeenCalled()
    expect(human.update).not.toHaveBeenCalled()
  })

  it('creates a workspace on a new branch', async () => {
    human.provision.mockResolvedValue({ id: 66, name: 'login', branchName: 'login', worktreePath: '/wt/5-xui/login' })
    const text = await createOperonActions(storage(), () => '小Q').createWorkspace({ projectId: 5, name: 'login', base: 'main' })
    expect(human.provision).toHaveBeenCalledWith(expect.anything(), { projectId: 5, name: 'login', base: 'main' })
    expect(text).toBe('Created workspace 66 "login" in project "xui" on a new branch login from main, at /wt/5-xui/login.')
  })

  it('changes the board the way the user does, under the assistant’s name', async () => {
    const s = storage()
    const actions = createOperonActions(s, () => '小Q')
    human.update.mockResolvedValue({ ok: true })
    expect(await actions.boardUpdate(5, 7, { status: 'done' })).toBe('Updated task #7 — now done.')
    expect(human.update).toHaveBeenCalledWith(s, task, { status: 'done' }, '小Q')

    human.comment.mockReturnValue({ activity: {}, woke: true })
    expect(actions.boardComment(5, 7, 'looks good')).toBe('Commented on task #7; its agent was told.')
    expect(human.comment).toHaveBeenCalledWith(s, task, 'looks good', '小Q')

    expect(actions.boardCreate(5, { title: 'Add divide', priority: 2 })).toBe('Created task #8 "Add divide" (todo).')
    expect(s.taskCreate).toHaveBeenCalledWith({ projectId: 5, title: 'Add divide', priority: 2, createdBy: 'human', actorName: '小Q' })
    expect(human.broadcast).toHaveBeenCalledWith(s, 71)
  })

  it('passes a gate refusal back as the reason', async () => {
    human.update.mockResolvedValue({ ok: false, status: 409, body: { error: 'Merge conflict in math.js' } })
    await expect(createOperonActions(storage(), () => '小Q').boardUpdate(5, 7, { status: 'done' })).rejects.toThrow(
      'Could not update task #7: Merge conflict in math.js',
    )
  })

  it('adds a repository on disk as a project with a workspace per worktree, and refuses what it should not', async () => {
    const s = storage() as unknown as OperonActionsStorage & { createProject: ReturnType<typeof vi.fn>; createWorkspace: ReturnType<typeof vi.fn> }
    const actions = createOperonActions(s, () => '小Q')
    await expect(actions.addProject({ path: 'relative/dir' })).rejects.toThrow('full path')
    expect(await actions.addProject({ path: '/src/xui/' })).toBe('Project 5 "xui" is already at /src/xui.')
    await expect(actions.addProject({ path: '/new/x', cloneUrl: 'file:///etc' })).rejects.toThrow('https://, ssh:// or git@')
    human.isGitRepo.mockResolvedValueOnce(false)
    await expect(actions.addProject({ path: '/not/a/repo' })).rejects.toThrow('is not a git repository')
    expect(s.createProject).not.toHaveBeenCalled()

    human.worktreeList.mockResolvedValueOnce([
      { path: '/src/api', branch: 'refs/heads/main', head: 'a', detached: false },
      { path: '/wt/api-fix', branch: 'refs/heads/fix', head: 'b', detached: false },
    ])
    expect(await actions.addProject({ path: '/src/api' })).toBe('Added project 9 "api" at /src/api, with workspace 90 "main", workspace 90 "fix".')
    expect(s.createWorkspace).toHaveBeenCalledWith(9, { name: 'fix', branchName: 'fix', worktreePath: '/wt/api-fix' })
  })

  it('opens a PR only from a workspace on its own branch, after committing and pushing it', async () => {
    const actions = createOperonActions(storage(), () => '小Q')
    await expect(actions.githubPrCreate(6, { title: 'x' })).rejects.toThrow('is on main itself')
    expect(human.prepare).not.toHaveBeenCalled()

    human.ghPrCreate.mockResolvedValue({ number: 12, url: 'https://github.com/o/xui/pull/12', title: 'Fix login' })
    expect(await actions.githubPrCreate(66, { title: 'Fix login' })).toBe('Opened pull request #12 from login into main: https://github.com/o/xui/pull/12')
    expect(human.prepare).toHaveBeenCalledWith('/wt/login', { branchName: 'login', baseBranch: 'main', commitMessage: 'Fix login' })

    human.ghStatus.mockResolvedValueOnce({ isInstalled: true, isAuthenticated: false })
    await expect(actions.githubPrs(5)).rejects.toThrow('gh auth login')
  })

  it('lists pull requests by where they stand', async () => {
    human.ghPrList.mockResolvedValue([
      { number: 12, title: 'Fix login', url: 'u12', state: 'OPEN', isDraft: false, headRefName: 'login', baseRefName: 'main', author: 'nick', updatedAt: '', reviewDecision: 'CHANGES_REQUESTED', checks: { passed: 3, failed: ['test'], pending: 0 } },
    ])
    expect(await createOperonActions(storage(), () => '小Q').githubPrs(5)).toBe(
      '- #12 "Fix login" · open · changes requested · checks: 1 failing (test) · login → main · by nick · u12',
    )
  })

  it('shows where a board task is linked outside the app', async () => {
    vi.spyOn((await import('../agent-comm/task-board-service.js')).TaskBoardService.prototype, 'get').mockResolvedValue('# Task #7: Ship login')
    expect(await createOperonActions(storage(), () => '小Q').boardGet(5, 7)).toBe(
      '# Task #7: Ship login\n\n## Linked\n- Pull request o/xui#12 https://github.com/o/xui/pull/12',
    )
  })
})
