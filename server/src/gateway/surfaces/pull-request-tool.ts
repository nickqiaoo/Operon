import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProjectStorageAdapter, TaskStorageAdapter } from '../../storage/interface.js'
import type { Task } from '../../types/task.js'
import { getSaasConfig } from '../../gateway/saas/config.js'
import {
  createPullRequest,
  findOpenPullRequest,
  getDefaultBranch,
  gitAuthEnv,
  installationToken,
  parseRepoFull,
  GithubAppError,
} from '../../services/integrations/github-app.js'
import { claimRoute, repoOfProject } from '../../services/integrations/project-repos.js'
import { broadcastTask } from '../../services/task-events.js'
import { taskMarker } from './inbound-github.js'

// submit_pull_request (docs/linear-github/design.md §10): push the task
// branch and open the PR, or push to the PR already open for it. The only way
// code leaves the worktree, and the credential never touches the worktree:
// the push authenticates through GIT_CONFIG_* for this one command.

const execFileAsync = promisify(execFile)

export interface SubmitPullRequestInput {
  title: string
  body: string
  branch: string
}

export interface SubmitPullRequestResult {
  text: string
  isError?: boolean
  url?: string
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

export async function submitPullRequest(
  storage: TaskStorageAdapter & ProjectStorageAdapter,
  task: Task,
  input: SubmitPullRequestInput,
): Promise<SubmitPullRequestResult> {
  const fail = (text: string): SubmitPullRequestResult => ({ text, isError: true })

  if (task.sddManaged && task.parentTaskId != null) {
    return fail('Subtasks merge into the parent change branch; the parent task opens the pull request.')
  }
  const workspace = task.workspaceId != null ? storage.getWorkspace(task.workspaceId) : null
  if (!workspace) return fail('This task has no worktree yet; it must be dispatched first.')
  const cwd = workspace.worktreePath
  const repoFull = await repoOfProject(cwd)
  const repo = repoFull ? parseRepoFull(repoFull) : null
  if (!repo) return fail('The worktree has no GitHub origin remote, so there is nowhere to open a pull request.')

  const branch = input.branch.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(branch)) return fail(`"${branch}" is not a valid branch name.`)

  let token: string
  try {
    token = await installationToken(repo)
  } catch (err) {
    if (err instanceof GithubAppError) return fail(err.message)
    throw err
  }
  const base = await getDefaultBranch(repo)
  if (branch === base) return fail(`Refusing to push to the default branch "${base}"; create a feature branch first.`)

  const dirty = (await git(cwd, ['status', '--porcelain'])).trim()
  if (dirty) return fail(`The working tree has uncommitted changes; commit (or discard) them first:\n${dirty}`)
  const head = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (head !== branch) return fail(`HEAD is on "${head}", not "${branch}"; check out the branch you want to submit.`)

  const pushUrl = `https://github.com/${repo.owner}/${repo.name}.git`
  try {
    await git(cwd, ['push', '--quiet', pushUrl, `HEAD:refs/heads/${branch}`], gitAuthEnv(token))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`git push failed: ${msg.replace(token, '***')}`)
  }

  const key = `${repo.owner}/${repo.name}#`
  const existing = await findOpenPullRequest(repo, branch)
  if (existing) {
    storage.taskSurfaceUpsert({
      taskId: task.id,
      kind: 'github_pr',
      externalId: key + existing.number,
      url: existing.url,
      meta: { repo: repoFull, number: existing.number, head: branch, base: existing.base, state: 'open', merged: false },
    })
    storage.taskAppendActivity(task.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: `Pushed ${branch} to PR #${existing.number}`,
      meta: { event: 'pr.pushed', branch, number: existing.number, source: 'github_pr', pr: key + existing.number, url: existing.url },
    })
    broadcastTask(storage, task.id)
    return { text: `Pushed ${branch}. Pull request already open: ${existing.url}`, url: existing.url }
  }

  const nodeId = getSaasConfig().nodeId ?? 'local'
  const pr = await createPullRequest(repo, {
    title: input.title.trim().slice(0, 200),
    body: `${input.body.trim()}\n\n${taskMarker(task.id, nodeId)}\n`,
    head: branch,
    base,
  })
  storage.taskSurfaceUpsert({
    taskId: task.id,
    kind: 'github_pr',
    externalId: key + pr.number,
    url: pr.url,
    meta: { repo: repoFull, number: pr.number, head: branch, base, state: 'open', merged: false },
  })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: `Opened PR #${pr.number}`,
    meta: { event: 'pr.opened', number: pr.number, source: 'github_pr', pr: key + pr.number, url: pr.url },
  })
  broadcastTask(storage, task.id)
  // Comments on this PR come back to this machine.
  void claimRoute('github_pr', key + pr.number)
  return { text: `Pushed ${branch} and opened pull request #${pr.number}: ${pr.url}`, url: pr.url }
}
