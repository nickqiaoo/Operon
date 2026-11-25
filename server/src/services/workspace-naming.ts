import type { ProjectStorageAdapter } from '../storage/interface.js'
import type { Workspace } from '../types/project.js'
import { runOneShotPrompt } from './ai/one-shot.js'
import { getCommitMessageConfig } from './commit-message-config.js'
import {
  branchHasUpstream,
  getCurrentBranch,
  getDefaultBaseBranch,
  listCommitSubjectsSince,
  localBranchExists,
  renameBranch,
} from './git.js'

/**
 * A chat's worktree starts under a placeholder (`provisionAutoWorkspace`). Each
 * message sent in it asks a small model whether the chat has said what the work
 * is yet; the first time it has, the workspace gets a title and its branch goes
 * from `operon/<id>` to `operon/<slug>`. A greeting ("hi") leaves the
 * placeholder for the next message. At most `MAX_ATTEMPTS` messages are tried,
 * and a push of a still-unnamed branch names it from its commits first, so a
 * placeholder branch never reaches the remote. Never renamed once pushed.
 */

export const MAX_ATTEMPTS = 3
export const WORKSPACE_TITLE_MAX_CHARS = 48
const SLUG_MAX_CHARS = 32
const CONTEXT_MAX_CHARS = 2_000
const GENERATION_TIMEOUT_MS = 60_000
/** How long a push waits for a name before it goes out under the placeholder. */
const PUSH_WAIT_MS = 20_000

export type WorkspaceNamingStorage = Pick<
  ProjectStorageAdapter,
  'getWorkspace' | 'getWorkspaceByPath' | 'replacePlaceholderWorkspaceName'
>

/** Messages tried per workspace (in memory: a restart gives a placeholder a few more tries). */
const attempts = new Map<number, number>()
/** Workspaces being named → the run, so a push can wait on it. */
const pending = new Map<number, Promise<boolean>>()

function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** Lowercase Latin words joined by "-", cut at a word boundary to fit a branch name. */
export function toSlug(raw: string): string {
  const words = raw.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const picked: string[] = []
  for (const word of words) {
    if ([...picked, word].join('-').length > SLUG_MAX_CHARS) break
    picked.push(word)
  }
  return picked.join('-')
}

/**
 * The model's reply as a name, or null when it said the chat has not said what
 * the work is yet (or replied with something unusable).
 */
export function parseWorkspaceName(raw: string): { title: string; slug: string } | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { title, slug } = parsed as { title?: unknown; slug?: unknown }
  if (typeof title !== 'string') return null
  const cleanTitle = title.replace(/\s+/g, ' ').replace(/[.。]$/, '').trim()
  if (!cleanTitle) return null
  return {
    title: truncate(cleanTitle, WORKSPACE_TITLE_MAX_CHARS),
    slug: toSlug(typeof slug === 'string' && slug.trim() ? slug : cleanTitle),
  }
}

function buildPrompt(context: string, force: boolean): string {
  const rules = [
    'Reply with ONLY a JSON object on one line, no prose, no code fence: {"title": "...", "slug": "..."}',
    `title: what the work is, at most ${WORKSPACE_TITLE_MAX_CHARS} characters, like an issue title, in the user's language (Chinese messages get a Chinese title).`,
    `slug: the same in English for a git branch name: 2 to 5 lowercase words joined by "-", at most ${SLUG_MAX_CHARS} characters.`,
    force
      ? 'Always give a name, even if the work is unclear.'
      : 'If the messages do not say what to work on yet (a greeting, "continue", small talk), reply {"title": null}.',
    'Do NOT call any tools — use only the text below.',
  ]
  const heading = force ? 'Commits on the branch' : 'Messages from the user'
  return `Name the git worktree a coding chat is working in.\n\nRules:\n- ${rules.join('\n- ')}\n\n# ${heading}\n${context}`
}

async function generateName(context: string, cwd: string, force: boolean, signal: AbortSignal) {
  const config = getCommitMessageConfig()
  const raw = await runOneShotPrompt({
    prompt: buildPrompt(context, force),
    cwd,
    providerId: config.providerId || 'claude',
    modelId: config.modelId || undefined,
    signal,
  })
  return parseWorkspaceName(raw)
}

/**
 * The branch to rename the placeholder one to, or the current one when it must
 * stay: already pushed (renaming would orphan the remote branch), not checked
 * out here any more, or every candidate name is taken.
 */
async function nextBranchName(workspace: Workspace, slug: string): Promise<string> {
  const current = workspace.branchName
  const path = workspace.worktreePath
  if (!slug) return current
  if ((await getCurrentBranch(path)) !== current) return current
  if (await branchHasUpstream(path, current)) return current
  for (let n = 1; n <= 20; n++) {
    const candidate = `operon/${n === 1 ? slug : `${slug}-${n}`}`
    if (candidate === current) return current
    if (await localBranchExists(path, candidate)) continue
    await renameBranch(path, current, candidate)
    return candidate
  }
  return current
}

function run(storage: WorkspaceNamingStorage, workspace: Workspace, context: string, force: boolean, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const id = workspace.id
  const task = (async () => {
    try {
      const name = await generateName(context, workspace.worktreePath, force, controller.signal)
      if (!name) return false
      // Re-read: it may have been named or deleted while the model ran.
      const latest = storage.getWorkspace(id)
      if (latest?.nameSource !== 'placeholder') return false
      let branch = latest.branchName
      try {
        branch = await nextBranchName(latest, name.slug)
      } catch (err) {
        console.warn(`[operon] workspace name: could not rename the branch of workspace=${id}:`, err instanceof Error ? err.message : err)
      }
      const applied = storage.replacePlaceholderWorkspaceName(id, name.title, branch)
      if (applied) attempts.delete(id)
      return applied
    } catch (err) {
      console.warn(`[operon] workspace name: generation failed for workspace=${id}; keeping the placeholder:`, err instanceof Error ? err.message : err)
      return false
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  })()
  pending.set(id, task)
  return task
}

/**
 * A message was sent in `workspaceId`: name it from `text` if it is still a
 * placeholder and has tries left. Does not wait: the name lands in the
 * background (the sidebar hears of it through the project-tree feed). Returns
 * that run (true when a name went in), or null when nothing was asked.
 */
export function nameWorkspaceFromMessage(storage: WorkspaceNamingStorage, workspaceId: number, text: string): Promise<boolean> | null {
  const context = text.trim()
  if (!context) return null
  const workspace = storage.getWorkspace(workspaceId)
  if (workspace?.nameSource !== 'placeholder' || pending.has(workspaceId)) return null
  const tried = attempts.get(workspaceId) ?? 0
  if (tried >= MAX_ATTEMPTS) return null
  attempts.set(workspaceId, tried + 1)
  return run(storage, workspace, context.slice(-CONTEXT_MAX_CHARS), false, GENERATION_TIMEOUT_MS)
}

/**
 * Before pushing the branch checked out at `worktreePath`: if its workspace is
 * still a placeholder, name it from the branch's commits (waiting at most
 * `PUSH_WAIT_MS`), so the branch goes out as `operon/<slug>`. Never throws.
 */
export async function nameWorkspaceBeforePush(storage: WorkspaceNamingStorage, worktreePath: string): Promise<void> {
  try {
    const workspace = storage.getWorkspaceByPath(worktreePath)
    if (workspace?.nameSource !== 'placeholder') return
    const inFlight = pending.get(workspace.id)
    if (inFlight && (await withTimeout(inFlight, PUSH_WAIT_MS))) return
    const latest = storage.getWorkspace(workspace.id)
    if (latest?.nameSource !== 'placeholder' || pending.has(latest.id)) return
    const base = await getDefaultBaseBranch(worktreePath)
    const subjects = base ? await listCommitSubjectsSince(worktreePath, base, 20) : []
    if (subjects.length === 0) return
    await run(storage, latest, subjects.join('\n').slice(0, CONTEXT_MAX_CHARS), true, PUSH_WAIT_MS)
  } catch (err) {
    console.warn('[operon] workspace name: naming before push failed:', err instanceof Error ? err.message : err)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))])
  clearTimeout(timer)
  return result
}

/** Test hook: forget the tries made so far. */
export function resetWorkspaceNamingForTests(): void {
  attempts.clear()
  pending.clear()
}
