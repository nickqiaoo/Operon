import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProjectStorageAdapter } from '../storage/interface.js'
import type { Workspace, WorkspaceNameSource } from '../types/project.js'
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
    /** Defaults to 'user'. */
    nameSource?: WorkspaceNameSource
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
    ...(input.nameSource ? { nameSource: input.nameSource } : {}),
  })
}

/** What the sidebar shows for a chat's worktree until it is named from the chat. */
export const PLACEHOLDER_WORKSPACE_NAME = 'New worktree'

function shortId(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

/**
 * A chat's worktree, made on its first send before anyone has said what it is
 * for: directory and branch get a short random id (`<id>`, `operon/<id>`), the
 * sidebar shows a placeholder, and `workspace-naming` swaps in a real name (and
 * renames the branch) once a message says what the work is. The directory is
 * never renamed, so nothing running in it has to move.
 */
export async function provisionAutoWorkspace(
  storage: Pick<ProjectStorageAdapter, 'getProject' | 'createWorkspace'>,
  input: { projectId: number; base?: string },
  random: () => string = shortId,
): Promise<Workspace> {
  const project = storage.getProject(input.projectId)
  if (!project) throw new Error(`There is no project ${input.projectId}.`)
  for (let n = 1; n <= 50; n++) {
    const id = random()
    const branch = `operon/${id}`
    const taken =
      existsSync(worktreePathFor(input.projectId, project.rootPath, id)) ||
      (await localBranchExists(project.rootPath, branch))
    if (taken) continue
    return provisionWorkspace(storage, {
      projectId: input.projectId,
      name: PLACEHOLDER_WORKSPACE_NAME,
      branch,
      dir: id,
      base: input.base,
      nameSource: 'placeholder',
    })
  }
  throw new Error('Could not find a free worktree name.')
}
