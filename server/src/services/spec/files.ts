/**
 * The spec's files on its change branch.
 *
 * Everything a spec run produces is a markdown or JSON file under
 * `.operon/changes/task-<N>/` in the change worktree, committed by the server.
 * Agents never write here themselves (they run in throwaway worktrees and hand
 * back their reply), so the only writer is this module — serialized per task,
 * because two concurrent commits in one worktree fight over git's index lock.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { commit } from '../git.js'

/** Every file a spec can have, by role. Paths are relative to the spec directory. */
export const SPEC_FILES = {
  brief: 'brief.md',
  grounding: 'grounding.md',
  rubric: 'rubric.json',
  judge: 'judge.md',
  design: 'design.md',
  synthesis: 'synthesis.md',
  questions: 'questions.json',
  answers: 'answers.md',
  feedback: 'feedback.md',
  tickets: 'tickets.json',
  /** ⑥ the consolidated whole-change review (structured); review.md is rendered from it once final. */
  reviewJson: 'review.json',
  review: 'review.md',
  /** The ADRs and glossary terms the change records at gate 2. */
  decisions: 'decisions.json',
  /** A sign-off conflict being resolved; see SpecIntegration. */
  integration: 'integration.json',
} as const

/** One reviewer's raw review of the whole change: `reviews/<provider>.json`. */
export function branchReviewFile(providerId: string): string {
  return path.posix.join('reviews', `${providerId}.json`)
}

export type SpecFileName = (typeof SPEC_FILES)[keyof typeof SPEC_FILES]

/** Candidate designs live one per file: `candidates/A.md`, `candidates/B.md`, … */
export function candidateFile(key: string): string {
  return path.posix.join('candidates', `${key}.md`)
}

/** The spec directory inside the change worktree. */
export function specDir(taskNumber: number): string {
  return path.posix.join('.operon', 'changes', `task-${taskNumber}`)
}

/** git blob id of content — matches `git hash-object`, without spawning git. */
export function blobSha(content: string): string {
  const data = Buffer.from(content, 'utf8')
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`, 'utf8'), data])).digest('hex')
}

export interface SpecLocation {
  taskId: number
  taskNumber: number
  /** Absolute path of the change worktree. */
  worktreePath: string
}

const writeChains = new Map<number, Promise<unknown>>()

function serialized<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  const prior = writeChains.get(taskId) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  writeChains.set(taskId, next.catch(() => undefined))
  return next
}

function isNothingToCommit(error: unknown): boolean {
  return /nothing to commit|no changes added to commit|working tree clean/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

/**
 * Write (or, with `null`, delete) spec files and commit them in one commit.
 * Writing identical content is not an error — the commit is simply skipped.
 * `alsoCommit` names repository paths outside the spec directory that the
 * caller already wrote and that belong in the same commit.
 */
export function writeSpecFiles(
  loc: SpecLocation,
  files: Record<string, string | null>,
  message: string,
  options: { alsoCommit?: string[] } = {},
): Promise<void> {
  return serialized(loc.taskId, async () => {
    const dir = path.join(loc.worktreePath, specDir(loc.taskNumber))
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel)
      if (content === null) {
        await fs.rm(abs, { force: true })
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
      }
    }
    try {
      // Only the spec's own directory: design agents run in disposable worktrees
      // nested in this checkout, and `add -A` would commit a running one as a gitlink.
      await commit(loc.worktreePath, `spec(task #${loc.taskNumber}): ${message}`, {
        paths: [specDir(loc.taskNumber), ...(options.alsoCommit ?? [])],
      })
    } catch (error) {
      if (!isNothingToCommit(error)) throw error
    }
  })
}

/** Read one spec file; null when it does not exist (yet). */
export async function readSpecFile(loc: SpecLocation, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(loc.worktreePath, specDir(loc.taskNumber), rel), 'utf8')
  } catch {
    return null
  }
}

/** Read and parse a JSON spec file; null when missing or unreadable. */
export async function readSpecJson<T>(loc: SpecLocation, rel: string): Promise<T | null> {
  const text = await readSpecFile(loc, rel)
  if (text == null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Candidate keys present on disk, in order (A, B, …). */
export async function listCandidateKeys(loc: SpecLocation): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(loc.worktreePath, specDir(loc.taskNumber), 'candidates'))
    return entries
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}
