import os from 'node:os'
import path from 'node:path'

/**
 * Base directory for all auto-provisioned worktrees (channel agents, task
 * dispatch, Linear, mate). Lives under ~/.operon alongside the rest of operon's
 * home-level state (data / models / vector / logs) instead of cluttering the
 * repo's sibling directory. Override with OPERON_WORKTREES_DIR.
 */
export function worktreesRoot(): string {
  return process.env.OPERON_WORKTREES_DIR || path.join(os.homedir(), '.operon', 'worktrees')
}

/**
 * Directory holding one project's worktrees, namespaced by project id so repos
 * that share a basename don't collide under the shared root.
 */
export function projectWorktreesDir(projectId: number, repoPath: string): string {
  return path.join(worktreesRoot(), `${projectId}-${path.basename(repoPath)}`)
}

/** Full path for a named worktree within a project's worktrees directory. */
export function worktreePathFor(projectId: number, repoPath: string, name: string): string {
  return path.join(projectWorktreesDir(projectId, repoPath), name)
}

/**
 * Sanitize a free-form string (agent name, suffix, issue id) into a single
 * filesystem- and git-ref-safe path segment. Strips everything outside
 * [A-Za-z0-9_-] so a name can never contain a '/' and bleed across segments,
 * and never produces an empty segment.
 */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[-_]+|[-_]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'x'
}
