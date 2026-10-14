import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { TaskPriority, TaskStatus, UpdateTaskInput } from '../../types/task.js'
import { getDefaultBaseBranch, isGitRepo, worktreeList } from '../git.js'
import { getGhStatus, ghPrCreate, ghPrList, ghPrView, type GhPrSummary } from '../integrations/gh-cli.js'
import { prepareBranchForPr } from '../integrations/github-pr.js'
import { TaskBoardService, type TaskBoardStorage } from '../agent-comm/task-board-service.js'
import { broadcastTask } from '../task-events.js'
import { commentOnTaskAsHuman, updateTaskAsHuman, type HumanTaskStorage } from '../task-human-actions.js'
import { provisionWorkspace } from '../workspace-provision.js'

/**
 * What the main agent changes in the rest of the app on the user's behalf
 * (docs/assistant/operon-manager.md §4): new workspaces, and the project board. Board changes go
 * the way the user's own do (task-human-actions.ts) — same gates, same side effects — recorded
 * under the assistant's name. Answers are plain text for the model; failures are thrown.
 */

export type OperonActionsStorage = TaskBoardStorage & HumanTaskStorage

export interface OperonActions {
  /** Register a repository on disk as a project, cloning it there first when `cloneUrl` is given. */
  addProject(input: { path: string; cloneUrl?: string; name?: string }): Promise<string>
  createWorkspace(input: { projectId: number; name: string; base?: string }): Promise<string>
  githubPrs(projectId: number, state?: 'open' | 'closed' | 'merged' | 'all'): Promise<string>
  githubPr(projectId: number, number: number): Promise<string>
  /** Commit what the workspace has, push its branch and open a pull request from it. */
  githubPrCreate(workspaceId: number, input: { title: string; body?: string; base?: string; draft?: boolean }): Promise<string>
  boardList(projectId: number, status?: TaskStatus): string
  boardGet(projectId: number, task: number): Promise<string>
  boardCreate(projectId: number, input: { title: string; description?: string; priority?: TaskPriority }): string
  boardUpdate(projectId: number, task: number, updates: UpdateTaskInput): Promise<string>
  boardComment(projectId: number, task: number, body: string): string
}

export function createOperonActions(storage: OperonActionsStorage, actorName: () => string): OperonActions {
  const project = (id: number) => {
    const found = storage.getProject(id)
    if (!found) throw new Error(`There is no project ${id}. Call workspace_list for the ids.`)
    return found
  }
  const task = (projectId: number, number: number) => {
    project(projectId)
    const found = storage.taskGetByNumber(projectId, number)
    if (!found) throw new Error(`Task #${number} is not on project ${projectId}'s board.`)
    return found
  }

  const workspace = (id: number) => {
    const found = storage.getWorkspace(id)
    if (!found) throw new Error(`There is no workspace ${id}. Call workspace_list for the ids.`)
    return found
  }
  const gh = async () => {
    const status = await getGhStatus()
    if (!status.isInstalled) throw new Error('The GitHub CLI (gh) is not installed on this computer.')
    if (!status.isAuthenticated) throw new Error('The GitHub CLI is not signed in; the user has to run `gh auth login` once.')
  }

  return {
    async addProject({ path, cloneUrl, name }) {
      if (!isAbsolute(path)) throw new Error('Give the full path of the folder.')
      const root = resolve(path)
      const known = storage.listProjects().find((p) => resolve(p.rootPath) === root)
      if (known) return `Project ${known.id} "${known.name}" is already at ${root}.`
      if (cloneUrl) {
        if (!/^(https:\/\/|git@|ssh:\/\/)/.test(cloneUrl)) throw new Error('Clone from an https://, ssh:// or git@ URL.')
        if (existsSync(root)) throw new Error(`${root} already exists; pick a folder that does not.`)
        await mkdir(dirname(root), { recursive: true })
        try {
          await run('git', ['clone', '--', cloneUrl, root], { timeout: CLONE_TIMEOUT_MS })
        } catch (error) {
          const e = error as { stderr?: string; message?: string }
          throw new Error(`git clone failed: ${(e.stderr || e.message || '').trim()}`)
        }
      }
      if (!(await isGitRepo(root))) throw new Error(`${root} is not a git repository.`)
      const created = storage.createProject({ name: name?.trim() || basename(root), rootPath: root })
      // One workspace per worktree the repository already has, as adding it from the sidebar does.
      const entries = await worktreeList(root).catch(() => [])
      const checkouts = entries.length ? entries : [{ path: root, branch: null, detached: false, head: null }]
      const workspaces = checkouts.map((entry) => {
        const branch = entry.branch?.replace(/^refs\/heads\//, '') ?? (entry.detached ? 'detached' : 'main')
        return storage.createWorkspace(created.id, {
          name: branch === 'detached' ? basename(entry.path) : branch,
          branchName: branch,
          worktreePath: entry.path,
        })
      })
      return `${cloneUrl ? 'Cloned and added' : 'Added'} project ${created.id} "${created.name}" at ${root}, with ${workspaces
        .map((w) => `workspace ${w.id} "${w.name}"`)
        .join(', ')}.`
    },

    async githubPrs(projectId, state = 'open') {
      const p = project(projectId)
      await gh()
      const prs = await ghPrList(p.rootPath, state)
      if (!prs.length) return `No ${state === 'all' ? '' : `${state} `}pull requests in ${p.name}.`
      return prs.map(prLine).join('\n')
    },

    async githubPr(projectId, number) {
      const p = project(projectId)
      await gh()
      const pr = await ghPrView(p.rootPath, number)
      const lines = [prLine(pr), '', pr.body.trim() ? clip(pr.body.trim(), 2_000) : '(no description)']
      if (pr.comments.length) {
        lines.push('', 'Latest comments:', ...pr.comments.map((c) => `- ${c.author}: ${clip(c.body.replace(/\s+/g, ' '), 400)}`))
      }
      return lines.join('\n')
    },

    async githubPrCreate(workspaceId, { title, body, base, draft }) {
      const ws = workspace(workspaceId)
      await gh()
      const baseBranch = base ?? (await getDefaultBaseBranch(ws.worktreePath)) ?? 'main'
      if (ws.branchName === baseBranch) {
        throw new Error(`Workspace "${ws.name}" is on ${baseBranch} itself; a pull request needs its own branch (workspace_create).`)
      }
      await prepareBranchForPr(ws.worktreePath, { branchName: ws.branchName, baseBranch, commitMessage: title })
      const pr = await ghPrCreate(ws.worktreePath, { headBranch: ws.branchName, baseBranch, title, body: body ?? '', draft: draft ?? false })
      return `Opened pull request #${pr.number} from ${ws.branchName} into ${baseBranch}: ${pr.url}`
    },

    async createWorkspace({ projectId, name, base }) {
      const p = project(projectId)
      const ws = await provisionWorkspace(storage, { projectId, name, ...(base ? { base } : {}) })
      return `Created workspace ${ws.id} "${ws.name}" in project "${p.name}" on a new branch ${ws.branchName}${base ? ` from ${base}` : ''}, at ${ws.worktreePath}.`
    },

    boardList(projectId, status) {
      project(projectId)
      return new TaskBoardService(storage, projectId).list(status ? { status } : {})
    },

    async boardGet(projectId, number) {
      const t = task(projectId, number)
      const text = await new TaskBoardService(storage, projectId).get(number)
      // Where the same task lives outside the app: its Linear issue, its pull request.
      const surfaces = storage.taskSurfaceList(t.id)
      if (!surfaces.length) return text
      const labels = { linear_issue: 'Linear issue', linear_session: 'Linear agent session', github_pr: 'Pull request' } as const
      return `${text}\n\n## Linked\n${surfaces.map((s) => `- ${labels[s.kind]} ${s.externalId}${s.url ? ` ${s.url}` : ''}`).join('\n')}`
    },

    boardCreate(projectId, input) {
      project(projectId)
      const created = storage.taskCreate({
        projectId,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.priority != null ? { priority: input.priority } : {}),
        createdBy: 'human',
        actorName: actorName(),
      })
      broadcastTask(storage, created.id)
      return `Created task #${created.number} "${created.title}" (todo).`
    },

    async boardUpdate(projectId, number, updates) {
      const existing = task(projectId, number)
      const result = await updateTaskAsHuman(storage, existing, updates, actorName())
      if (!result.ok) throw new Error(`Could not update task #${number}: ${describeRefusal(result.body)}`)
      const now = storage.taskGet(existing.id)
      return `Updated task #${number}${now ? ` — now ${now.status}` : ''}.`
    },

    boardComment(projectId, number, body) {
      const t = task(projectId, number)
      const { woke } = commentOnTaskAsHuman(storage, t, body, actorName())
      return `Commented on task #${number}${woke ? '; its agent was told' : ''}.`
    },
  }
}

const run = promisify(execFile)
const CLONE_TIMEOUT_MS = 10 * 60_000

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function prLine(pr: GhPrSummary): string {
  const review = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[pr.reviewDecision] ?? ''
  const { passed, failed, pending } = pr.checks
  const checks = passed + failed.length + pending
    ? `checks: ${failed.length ? `${failed.length} failing (${failed.join(', ')})` : pending ? `${pending} running` : 'all passing'}`
    : ''
  const parts = [pr.state.toLowerCase(), pr.isDraft ? 'draft' : '', review, checks, `${pr.headRefName} → ${pr.baseRefName}`, `by ${pr.author}`].filter(Boolean)
  return `- #${pr.number} "${pr.title}" · ${parts.join(' · ')} · ${pr.url}`
}

/** A refusal from the task gates: `{ error }`, or a gate's own detail. */
function describeRefusal(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  return JSON.stringify(body)
}
