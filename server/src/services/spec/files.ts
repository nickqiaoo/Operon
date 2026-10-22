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
import type { TaskStorageAdapter } from '../../storage/interface.js'

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

async function commitSpecFiles(loc: SpecLocation, message: string): Promise<void> {
  try {
    await commit(loc.worktreePath, `spec(task #${loc.taskNumber}): ${message}`, {
      paths: [specDir(loc.taskNumber)],
    })
  } catch (error) {
    if (!isNothingToCommit(error)) throw error
  }
}

async function writeExecutionFiles(loc: SpecLocation, files: Record<string, string | null>): Promise<void> {
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
}

/**
 * Persist document snapshots, then write (or delete) and commit the execution files.
 * Writing identical content is not an error — the commit is simply skipped.
 */
export function writeSpecFiles(
  storage: Pick<TaskStorageAdapter, 'specArtifactsWrite'>,
  loc: SpecLocation,
  files: Record<string, string | null>,
  message: string,
): Promise<void> {
  return serialized(loc.taskId, async () => {
    // Persist first: a database failure must not leave a file that resume would skip.
    storage.specArtifactsWrite(loc.taskId, files)
    await writeExecutionFiles(loc, files)
    // Only this spec's directory, never unrelated work in the checkout.
    await commitSpecFiles(loc, message)
  })
}

type ArtifactStorage = Pick<TaskStorageAdapter, 'specArtifactsRead' | 'specArtifactsWrite'>

/** Recover execution files if the app quit between the cleanup commit and landing. */
export async function restoreSpecFiles(storage: ArtifactStorage, loc: SpecLocation): Promise<void> {
  try {
    await fs.access(path.join(loc.worktreePath, specDir(loc.taskNumber)))
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const files = storage.specArtifactsRead(loc.taskId)
  if (Object.keys(files).length > 0) await writeSpecFiles(storage, loc, files, 'restore execution files')
}

/**
 * Snapshot the actual files (including direct edits), commit their removal, then
 * land the change. A failed landing restores the files so rework can continue.
 * The database snapshot survives the cleanup and worktree removal.
 */
export function withSpecFilesArchived<T extends { ok: boolean }>(
  storage: ArtifactStorage,
  loc: SpecLocation,
  land: () => Promise<T>,
): Promise<T> {
  return serialized(loc.taskId, async () => {
    const dir = path.join(loc.worktreePath, specDir(loc.taskNumber))
    const snapshot: Record<string, string> = {}
    async function readDirectory(relative: string): Promise<void> {
      const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true })
      for (const entry of entries) {
        const key = path.posix.join(relative, entry.name)
        if (entry.isDirectory()) await readDirectory(key)
        else if (entry.isFile()) snapshot[key] = await fs.readFile(path.join(dir, key), 'utf8')
      }
    }
    await readDirectory('')
    const removed = Object.fromEntries(
      Object.keys(storage.specArtifactsRead(loc.taskId))
        .filter((key) => !(key in snapshot))
        .map((key) => [key, null]),
    )
    // If persistence fails, leave the execution files untouched.
    storage.specArtifactsWrite(loc.taskId, { ...removed, ...snapshot })
    let landed = false
    try {
      await fs.rm(dir, { recursive: true, force: true })
      await commitSpecFiles(loc, 'remove intermediate files before sign-off')
      const result = await land()
      landed = result.ok
      return result
    } finally {
      if (!landed) {
        await writeExecutionFiles(loc, snapshot)
        await commitSpecFiles(loc, 'restore execution files after failed sign-off')
      }
    }
  })
}

/** Read one spec file; null when it does not exist (yet). */
export async function readSpecFile(loc: SpecLocation, rel: string): Promise<string | null> {
  try {
    const relativePath = path.posix.join(specDir(loc.taskNumber), rel)
    return await fs.readFile(path.join(loc.worktreePath, relativePath), 'utf8')
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
    const dir = path.posix.join(specDir(loc.taskNumber), 'candidates')
    const entries = await fs.readdir(path.join(loc.worktreePath, dir))
    return entries
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}
