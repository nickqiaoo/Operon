import type { ProjectStorageAdapter } from '../../storage/interface.js'
import type { Project } from '../../types/project.js'
import * as gitService from '../git.js'
import { parseGithubRemote } from './github.js'
import { claimRoutes, isBrokerConnected } from './broker-client.js'

// Local project ⇄ GitHub repository, read off each project's origin remote.
// This is the only "binding" there is: a Linear issue names its repository
// with a `repo:owner/name` label and the desktop looks the project up here
// (docs/linear-github/design.md §8.1). Nothing is configured.

let _storage: ProjectStorageAdapter | null = null

export function initProjectRepos(storage: ProjectStorageAdapter): void {
  _storage = storage
}

/** owner/name for a local project, from its origin remote; null when not GitHub. */
export async function repoOfProject(rootPath: string): Promise<string | null> {
  try {
    if (!(await gitService.isGitRepo(rootPath))) return null
    const remotes = await gitService.listRemotes(rootPath)
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0]
    const parsed = origin ? parseGithubRemote(origin.url) : null
    return parsed ? `${parsed.owner}/${parsed.repo}` : null
  } catch {
    return null
  }
}

/** The local project whose origin is owner/name (case-insensitive); null when none. */
export async function findProjectByRepo(fullName: string): Promise<Project | null> {
  const wanted = fullName.trim().toLowerCase()
  if (!wanted) return null
  for (const p of _storage?.listProjects() ?? []) {
    const repo = await repoOfProject(p.rootPath)
    if (repo && repo.toLowerCase() === wanted) return p
  }
  return null
}

/** One sticky row the desktop owns (a PR it opened, an issue it published). */
export async function claimRoute(kind: 'github_pr' | 'linear_issue', key: string): Promise<void> {
  if (!isBrokerConnected()) return
  try {
    await claimRoutes([{ kind, key }])
  } catch (err) {
    console.warn(`[integrations] claim ${kind} ${key} failed:`, err instanceof Error ? err.message : err)
  }
}
