import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProjectStorageAdapter } from '../storage/interface.js'
import type { Workspace } from '../types/project.js'
import { getDefaultBaseBranch, localBranchExists, worktreeAdd } from './git.js'
import { sanitizeSegment, worktreePathFor } from './worktree-paths.js'

/**
 * A new workspace for a project: a fresh branch checked out in its own worktree under operon's
 * managed worktrees dir (`worktreePathFor`), recorded so it shows in the sidebar. Shared by spec
 * change branches and the personal assistant.
 */
export async function provisionWorkspace(
  storage: Pick<ProjectStorageAdapter, 'getProject' | 'createWorkspace'>,
  input: {
    projectId: number
    /** What the sidebar shows. */
    name: string
    /** The new branch; defaults to the name made git-safe. */
    branch?: string
    /** The worktree's directory name; defaults to the branch made path-safe. */
    dir?: string
    /** What the branch starts from; defaults to the repository's default branch. */
    base?: string
    /** The conversation making it for an agent it dispatches (`Workspace.originChatId`). */
    originChatId?: number
  },
): Promise<Workspace> {
  const project = storage.getProject(input.projectId)
  if (!project) throw new Error(`There is no project ${input.projectId}.`)
  const branch = input.branch ?? sanitizeSegment(input.name)
  const worktreePath = worktreePathFor(input.projectId, project.rootPath, input.dir ?? sanitizeSegment(branch))
  if (existsSync(worktreePath)) throw new Error(`A worktree already exists at ${worktreePath}; pick another name.`)
  const base = input.base ?? (await getDefaultBaseBranch(project.rootPath)) ?? undefined
  // git worktree add won't create missing parent dirs.
  await mkdir(dirname(worktreePath), { recursive: true })
  await worktreeAdd(project.rootPath, worktreePath, branch, true, base)
  return storage.createWorkspace(input.projectId, {
    name: input.name, branchName: branch, worktreePath,
    ...(input.originChatId != null ? { originChatId: input.originChatId } : {}),
  })
}

/**
 * A short, git-safe name for a workspace made for a chat, from the words of its
 * first message: "Fix the login timeout" → `fix-the-login-timeout`. A message
 * with no Latin words (most Chinese ones) falls back to `chat-<4 chars>`.
 */
export function workspaceSlugFromHint(hint: string | undefined, random: () => string = randomSuffix): string {
  const words = (hint ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  const picked: string[] = []
  for (const word of words) {
    if (picked.length >= 5 || [...picked, word].join('-').length > 32) break
    picked.push(word)
  }
  return picked.length > 0 ? picked.join('-') : `chat-${random()}`
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

/**
 * A workspace nobody had to name: a fresh `operon/<slug>` branch cut from `base`
 * (the default branch when unset) in its own worktree. The slug comes from
 * `hint` and gets `-2`, `-3`… when that branch or directory is already taken.
 */
export async function provisionAutoWorkspace(
  storage: Pick<ProjectStorageAdapter, 'getProject' | 'createWorkspace'>,
  input: { projectId: number; base?: string; hint?: string },
): Promise<Workspace> {
  const project = storage.getProject(input.projectId)
  if (!project) throw new Error(`There is no project ${input.projectId}.`)
  const slug = workspaceSlugFromHint(input.hint)
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`
    const branch = `operon/${name}`
    const taken =
      existsSync(worktreePathFor(input.projectId, project.rootPath, name)) ||
      (await localBranchExists(project.rootPath, branch))
    if (taken) continue
    return provisionWorkspace(storage, { projectId: input.projectId, name, branch, dir: name, base: input.base })
  }
  throw new Error(`Could not find a free workspace name for "${slug}".`)
}
