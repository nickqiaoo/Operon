import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProjectStorageAdapter } from '../storage/interface.js'
import type { Workspace } from '../types/project.js'
import { getDefaultBaseBranch, worktreeAdd } from './git.js'
import { sanitizeSegment, worktreePathFor } from './worktree-paths.js'

/**
 * A new workspace for a project: a fresh branch checked out in its own worktree under operon's
 * managed worktrees dir (`worktreePathFor`), recorded so it shows in the sidebar. Shared by SDD
 * task dispatch and the personal assistant.
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
  return storage.createWorkspace(input.projectId, { name: input.name, branchName: branch, worktreePath })
}
