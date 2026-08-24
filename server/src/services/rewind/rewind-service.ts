import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

const exec = promisify(execFile)

// ---- Types ----

/** A file the revert refused to touch, with the reason it was left alone. */
export interface SkippedFile {
  path: string
  /** The file changed after this chat last wrote it, so reverting would drop someone else's edit. */
  reason: 'modified-by-others'
}

export interface RevertResult {
  success: boolean
  filesChanged: string[]
  /** Files excluded by the safety check; empty unless `verifyAgainst` was supplied. */
  skipped: SkippedFile[]
  backupSnapshotId?: string
  error?: string
}

/**
 * Per-file rewind targets: project-relative path → the tree its content is
 * restored from. Each file gets its own tree because a chat may have first
 * touched different files in different turns.
 */
export type RevertPlan = ReadonlyMap<string, string>

export interface RevertOptions {
  /**
   * Restrict the revert to these files. Without it every path that differs
   * between `snapshotId` and the live worktree is reverted — which sweeps in
   * edits made by other chats sharing this workspace.
   */
  plan?: RevertPlan
  /**
   * Path → tree holding the content this chat last left behind. A file whose
   * current content no longer matches was changed by someone else afterwards,
   * so it is skipped instead of silently overwritten.
   */
  verifyAgainst?: ReadonlyMap<string, string>
  /** Revert even the files `verifyAgainst` flags — the user confirmed the overwrite. */
  force?: boolean
}

export interface FileDiff {
  file: string
  additions: number
  deletions: number
}

/** Per-file change summary for a turn (snapshot → current worktree). */
export interface TurnFileChange {
  path: string
  /** Single-letter git status: M / A / D / R / … */
  status: string
  additions: number
  deletions: number
}

// ---- Mutex ----

/** Simple per-key async mutex to prevent concurrent git index operations on the same workspace */
class KeyedMutex {
  private locks = new Map<string, Promise<void>>()

  async acquire(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key)
    }
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(key, promise)
    return () => {
      this.locks.delete(key)
      release()
    }
  }
}

// ---- Service ----

const dataDir = process.env.OPERON_DATA_DIR || path.join(os.homedir(), '.operon', 'data')
const mutex = new KeyedMutex()

/** In-memory cache of last known tree hash per gitdir, used to skip git add when nothing changed */
const lastTreeHashCache = new Map<string, string>()

/** Marker file recording the last time a repo was used by capture (epoch ms). */
const USED_MARKER = 'rewind-last-used'

/**
 * Heavy directories and large binary/media files that must never enter a rewind
 * snapshot. Written to `$GIT_DIR/info/exclude`, which git honors unconditionally
 * on top of any workspace .gitignore — so dependency dirs (node_modules, Pods…)
 * and stray multi-GB assets never get staged by `git add .`, even when the
 * workspace .gitignore omits them.
 */
const DEFAULT_EXCLUDES = [
  '.git',
  // dependency / build output dirs
  'node_modules', '.next', 'dist', 'build', 'out', '.turbo', '.cache',
  'coverage', 'target', '.gradle', 'vendor', 'Pods', '.venv', '__pycache__',
  // editor / OS noise
  '.DS_Store',
  // large binaries & media — a stray multi-GB asset must not bloat snapshots
  '*.mp4', '*.mov', '*.mkv', '*.avi', '*.webm',
  '*.zip', '*.tar', '*.tgz', '*.gz', '*.bz2', '*.7z', '*.rar',
  '*.dmg', '*.iso', '*.img',
  '*.app', '*.ipa', '*.apk', '*.aab', '*.xcarchive', '*.car',
  '*.psd', '*.sketch', '*.bin', '*.wasm',
]

/** Derive sidecar gitdir path from workspace cwd */
function gitdir(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return path.join(dataDir, 'rewind', 'repos', hash)
}

/** Record that a repo was just used, so the orphan sweep can spare active ones. */
async function touchUsedMarker(gitDir: string): Promise<void> {
  try {
    await fs.writeFile(path.join(gitDir, USED_MARKER), String(Date.now()), 'utf-8')
  } catch {
    // best effort — recency tracking is not critical
  }
}

/** Ensure sidecar git repo exists and is properly configured */
async function ensureRepo(gitDir: string, cwd: string): Promise<void> {
  await fs.mkdir(gitDir, { recursive: true })

  try {
    await exec('git', ['--git-dir', gitDir, 'rev-parse', '--git-dir'])
  } catch {
    // Not initialized yet — init bare
    await exec('git', ['init', '--bare', gitDir])
    await exec('git', ['--git-dir', gitDir, 'config', 'core.autocrlf', 'false'])
  }

  // Always write our heavy-dir / large-binary excludes to info/exclude. git
  // honors this file unconditionally (on top of core.excludesFile and in-tree
  // .gitignore), so the heavy defaults apply regardless of the workspace setup.
  const excludesPath = path.join(gitDir, 'info', 'exclude')
  await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
  await fs.writeFile(excludesPath, DEFAULT_EXCLUDES.join('\n') + '\n', 'utf-8')

  // Additionally honor the workspace .gitignore when present.
  const workspaceGitignore = path.join(cwd, '.gitignore')
  try {
    await fs.access(workspaceGitignore)
    await exec('git', ['--git-dir', gitDir, 'config', 'core.excludesFile', workspaceGitignore])
  } catch {
    // No workspace .gitignore — info/exclude already covers the heavy defaults.
  }
}

// ---- Public API ----

/**
 * Capture the current file state of the workspace as a git tree hash.
 * Returns the tree hash (snapshotId) or null on failure.
 */
export async function capture(cwd: string): Promise<string | null> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await ensureRepo(gd, cwd)
    await touchUsedMarker(gd)

    // Fast path: if we have a cached hash, check if work-tree is unchanged before staging
    const cachedHash = lastTreeHashCache.get(gd)
    if (cachedHash) {
      try {
        const { stdout: statusOut } = await exec(
          'git', ['--git-dir', gd, '--work-tree', cwd, 'status', '--porcelain'],
          { cwd }
        )
        if (!statusOut.trim()) {
          console.log(`[Rewind] No changes detected, reusing snapshot ${cachedHash.slice(0, 8)}`)
          return cachedHash
        }
      } catch {
        // Fall through to full capture if status check fails
      }
    }

    // Stage all files
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'add', '.'], { cwd })

    // Write tree → returns hash
    const { stdout } = await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'write-tree'], { cwd })
    const hash = stdout.trim()
    if (!hash) return null

    lastTreeHashCache.set(gd, hash)
    console.log(`[Rewind] Captured snapshot ${hash} for ${cwd}`)
    return hash
  } catch (err) {
    console.error('[Rewind] Failed to capture snapshot:', err)
    return null
  } finally {
    release()
  }
}

/**
 * Project-relative paths that differ between two trees.
 *
 * Both endpoints are frozen git objects, so the answer was fixed the moment the
 * second tree was written and can never pick up later edits. That is what makes
 * per-chat attribution possible: diffing a tree against the live worktree
 * instead would sweep in everything every other chat did since.
 *
 * Takes no lock — it only reads immutable objects, touching neither the index
 * nor the worktree, so it is safe to call while a caller holds the repo mutex.
 */
export async function filesBetweenTrees(cwd: string, from: string, to: string): Promise<string[]> {
  const gd = gitdir(cwd)
  const { stdout } = await exec(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd,
     'diff', '--no-ext-diff', '--no-renames', '--name-only', from, to],
    { cwd }
  ).catch(() => ({ stdout: '' }))
  return stdout.trim().split('\n').filter(Boolean)
}

/**
 * Blob hash a path has inside a tree, or null when the tree has no such path.
 * Lock-free for the same reason as {@link filesBetweenTrees}.
 */
export async function blobInTree(cwd: string, tree: string, file: string): Promise<string | null> {
  const gd = gitdir(cwd)
  const { stdout } = await exec(
    'git',
    ['-c', 'core.quotepath=false', '--git-dir', gd, 'ls-tree', tree, '--', file],
    { cwd }
  ).catch(() => ({ stdout: '' }))
  // `<mode> <type> <hash>\t<path>`
  const parts = stdout.trim().split(/\s+/)
  return parts.length >= 3 && parts[2] ? parts[2] : null
}

/**
 * Blob hash the file's current worktree content hashes to, or null when it is
 * gone. Comparable to {@link blobInTree} because the sidecar repo pins
 * `core.autocrlf=false`, so neither side applies line-ending conversion.
 */
export async function blobInWorktree(cwd: string, file: string): Promise<string | null> {
  const gd = gitdir(cwd)
  return exec(
    'git',
    ['-c', 'core.autocrlf=false', '--git-dir', gd, '--work-tree', cwd, 'hash-object', '--', file],
    { cwd }
  )
    .then((r) => r.stdout.trim() || null)
    .catch(() => null)
}

/**
 * Revert files to their state at the given snapshot.
 *
 * Per-file strategy (preserved from snapshot/index.ts:93-123):
 * - `git checkout <tree> -- <file>`
 * - If checkout fails: check `git ls-tree` to see if the file existed in that tree
 *   - If it didn't exist → delete the file (it was newly created)
 *   - If it existed but checkout failed → keep it (log warning)
 *
 * Which files are touched depends on {@link RevertOptions.plan}: with a plan,
 * only its entries (each restored from its own tree); without one, every path
 * that differs between `snapshotId` and the live worktree — the legacy
 * behaviour, which cannot tell this chat's edits from another chat's.
 */
export async function revert(
  cwd: string,
  snapshotId: string,
  options?: RevertOptions,
): Promise<RevertResult> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    // Stage current state so diff includes untracked files
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'add', '.'], { cwd })

    // Create backup snapshot of current state (enables undo-rewind)
    let backupSnapshotId: string | undefined
    try {
      const { stdout } = await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'write-tree'], { cwd })
      backupSnapshotId = stdout.trim()
      if (backupSnapshotId) {
        console.log(`[Rewind] Created backup snapshot ${backupSnapshotId.slice(0, 8)} before revert`)
      }
    } catch (err) {
      console.warn('[Rewind] Failed to create backup snapshot:', err)
    }

    // Each candidate carries the tree its content is restored from: with a plan
    // that is the turn where this chat first touched the file, otherwise the
    // single snapshot being rewound to.
    let entries: [string, string][]
    if (options?.plan) {
      entries = [...options.plan]
    } else {
      const { stdout: diffOutput } = await exec(
        'git',
        ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd, '--work-tree', cwd,
         'diff', '--no-ext-diff', '--name-only', snapshotId, '--', '.'],
        { cwd }
      ).catch(() => ({ stdout: '' }))
      entries = diffOutput.trim().split('\n').filter(Boolean).map((file) => [file, snapshotId])
    }

    // Leave alone anything that changed after this chat last wrote it — that
    // content belongs to whoever wrote it, and reverting would drop it silently.
    const skipped: SkippedFile[] = []
    if (options?.verifyAgainst && !options.force) {
      const safe: [string, string][] = []
      for (const [file, tree] of entries) {
        const witness = options.verifyAgainst.get(file)
        if (!witness) {
          safe.push([file, tree])
          continue
        }
        const [expected, actual] = await Promise.all([
          blobInTree(cwd, witness, file),
          blobInWorktree(cwd, file),
        ])
        if (expected === actual) safe.push([file, tree])
        else skipped.push({ path: file, reason: 'modified-by-others' })
      }
      entries = safe
    }

    if (entries.length === 0) {
      return { success: true, filesChanged: [], skipped, backupSnapshotId }
    }

    const reverted = new Set<string>()

    // Core revert logic — preserved from snapshot/index.ts:93-123
    for (const [relativePath, tree] of entries) {
      const absolutePath = path.join(cwd, relativePath)
      if (reverted.has(absolutePath)) continue

      console.log(`[Rewind] Reverting: ${relativePath} to ${tree.slice(0, 8)}`)

      try {
        await exec(
          'git',
          ['--git-dir', gd, '--work-tree', cwd, 'checkout', tree, '--', relativePath],
          { cwd }
        )
      } catch {
        // Checkout failed — check if file existed in snapshot
        try {
          const { stdout: lsOutput } = await exec(
            'git',
            ['--git-dir', gd, '--work-tree', cwd, 'ls-tree', tree, '--', relativePath],
            { cwd }
          )
          if (lsOutput.trim()) {
            // File existed in snapshot but checkout failed — keep it
            console.warn(`[Rewind] File existed in snapshot but checkout failed, keeping: ${relativePath}`)
          } else {
            // File did NOT exist in snapshot → delete it
            console.log(`[Rewind] File did not exist in snapshot, deleting: ${relativePath}`)
            await fs.unlink(absolutePath).catch(() => {})
          }
        } catch {
          // ls-tree also failed — file didn't exist, delete
          console.log(`[Rewind] File did not exist in snapshot, deleting: ${relativePath}`)
          await fs.unlink(absolutePath).catch(() => {})
        }
      }

      reverted.add(absolutePath)
    }

    console.log(
      `[Rewind] Reverted ${reverted.size} file(s)${skipped.length ? `, skipped ${skipped.length} changed by others` : ''}`
    )
    // The worktree no longer matches any tree we know: a plan restores files
    // from several trees, and skipped files keep their current content.
    lastTreeHashCache.delete(gd)
    return { success: true, filesChanged: [...reverted], skipped, backupSnapshotId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Revert failed'
    console.error('[Rewind] Revert failed:', err)
    return { success: false, filesChanged: [], skipped: [], error: message }
  } finally {
    release()
  }
}

/**
 * Restore only the given paths from a snapshot; a path the snapshot does not
 * contain is deleted, since it did not exist when the snapshot was taken.
 *
 * This is the undo counterpart to a planned {@link revert}: it puts back
 * exactly what that revert touched, leaving every other chat's edits — made
 * before or since — untouched. Prefer it over {@link restore}, which rewrites
 * the whole worktree.
 */
export async function restoreFiles(cwd: string, snapshotId: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    for (const relativePath of files) {
      try {
        await exec(
          'git',
          ['--git-dir', gd, '--work-tree', cwd, 'checkout', snapshotId, '--', relativePath],
          { cwd }
        )
      } catch {
        await fs.unlink(path.join(cwd, relativePath)).catch(() => {})
      }
    }
    lastTreeHashCache.delete(gd)
    console.log(`[Rewind] Restored ${files.length} file(s) from ${snapshotId.slice(0, 8)}`)
  } catch (err) {
    console.error('[Rewind] Selective restore failed:', err)
  } finally {
    release()
  }
}

/**
 * Full restore: read-tree + checkout-index.
 *
 * Rewrites every path in the tree, so it also reverts changes this chat never
 * made. Use {@link restoreFiles} for undo-rewind; this stays for the explicit
 * "put the whole workspace back" case.
 */
export async function restore(cwd: string, snapshotId: string): Promise<void> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'read-tree', snapshotId], { cwd })
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'checkout-index', '-a', '-f'], { cwd })
    lastTreeHashCache.set(gd, snapshotId)
    console.log(`[Rewind] Full restore to ${snapshotId.slice(0, 8)}`)
  } catch (err) {
    console.error('[Rewind] Full restore failed:', err)
  } finally {
    release()
  }
}

/**
 * Get file change statistics between snapshot and current state.
 */
export async function diff(cwd: string, snapshotId: string): Promise<FileDiff[]> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'add', '.'], { cwd })
    // Invalidate cache: git add updated the index, so status-based fast path would be stale
    lastTreeHashCache.delete(gd)

    const { stdout } = await exec(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd, '--work-tree', cwd,
       'diff', '--no-ext-diff', '--no-renames', '--numstat', snapshotId, '--', '.'],
      { cwd }
    ).catch(() => ({ stdout: '' }))

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, file] = line.split('\t')
        return {
          file,
          additions: additions === '-' ? 0 : parseInt(additions, 10),
          deletions: deletions === '-' ? 0 : parseInt(deletions, 10),
        }
      })
  } finally {
    release()
  }
}

/**
 * Per-file changes between a snapshot and the current worktree, with status and
 * line counts. Used by the per-turn diff card and the review panel's file list.
 */
export async function changedFiles(cwd: string, snapshotId: string): Promise<TurnFileChange[]> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    // Stage so untracked (new) files show up in `git diff <snapshot>`.
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'add', '.'], { cwd })
    lastTreeHashCache.delete(gd)

    const runDiff = (mode: string) =>
      exec('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd, '--work-tree', cwd,
        'diff', '--no-ext-diff', '--no-renames', mode, snapshotId, '--', '.'], { cwd })
        .then((r) => r.stdout)
        .catch(() => '')
    const [numstat, nameStatus] = await Promise.all([runDiff('--numstat'), runDiff('--name-status')])

    const statusByPath = new Map<string, string>()
    for (const line of nameStatus.trim().split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t')
      if (file) statusByPath.set(file, status.charAt(0))
    }

    return numstat
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, file] = line.split('\t')
        return {
          path: file,
          status: statusByPath.get(file) ?? 'M',
          additions: additions === '-' ? 0 : parseInt(additions, 10),
          deletions: deletions === '-' ? 0 : parseInt(deletions, 10),
        }
      })
  } finally {
    release()
  }
}

/**
 * Per-file changes between two snapshots (tree-to-tree). Used to render one
 * turn's diff: its start snapshot → the next turn's start snapshot.
 */
export async function changedFilesBetween(
  cwd: string,
  baseSnapshot: string,
  targetSnapshot: string,
): Promise<TurnFileChange[]> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    const runDiff = (mode: string) =>
      exec('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd,
        'diff', '--no-ext-diff', '--no-renames', mode, baseSnapshot, targetSnapshot], { cwd })
        .then((r) => r.stdout)
        .catch(() => '')
    const [numstat, nameStatus] = await Promise.all([runDiff('--numstat'), runDiff('--name-status')])

    const statusByPath = new Map<string, string>()
    for (const line of nameStatus.trim().split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t')
      if (file) statusByPath.set(file, status.charAt(0))
    }

    return numstat
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, file] = line.split('\t')
        return {
          path: file,
          status: statusByPath.get(file) ?? 'M',
          additions: additions === '-' ? 0 : parseInt(additions, 10),
          deletions: deletions === '-' ? 0 : parseInt(deletions, 10),
        }
      })
  } finally {
    release()
  }
}

export interface TurnFileDiff {
  path: string
  status: string
  diff: string
}

/**
 * All per-file unified diffs for a snapshot → current worktree, in one shot.
 * Stages once (so new files diff correctly), then diffs each changed file
 * read-only and concurrently — so the review panel fetches a whole turn's diff
 * with a single request instead of one-per-file (which serialized on the repo
 * mutex and flooded the server).
 */
export async function turnFileDiffs(cwd: string, snapshotId: string): Promise<TurnFileDiff[]> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await exec('git', ['--git-dir', gd, '--work-tree', cwd, 'add', '.'], { cwd })
    lastTreeHashCache.delete(gd)

    const { stdout: nameStatus } = await exec('git',
      ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd, '--work-tree', cwd,
       'diff', '--no-ext-diff', '--no-renames', '--name-status', snapshotId, '--', '.'], { cwd }
    ).catch(() => ({ stdout: '' }))

    const entries = nameStatus
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t')
        return { path, status: (status ?? 'M').charAt(0) }
      })
      .filter((e) => e.path)

    // Reads are safe to run concurrently once the index is staged.
    return Promise.all(
      entries.map(async (e) => {
        const { stdout } = await exec('git',
          ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd, '--work-tree', cwd,
           'diff', '--no-ext-diff', '--no-renames', snapshotId, '--', e.path], { cwd }
        ).catch(() => ({ stdout: '' }))
        return { path: e.path, status: e.status, diff: stdout }
      }),
    )
  } finally {
    release()
  }
}

/**
 * All per-file unified diffs between two snapshots (tree-to-tree), in one call.
 * Used to review a historical turn: its start snapshot → the next turn's start.
 * Read-only — no staging or worktree needed.
 */
export async function turnFileDiffsBetween(
  cwd: string,
  baseSnapshot: string,
  targetSnapshot: string,
): Promise<TurnFileDiff[]> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    const { stdout: nameStatus } = await exec('git',
      ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd,
       'diff', '--no-ext-diff', '--no-renames', '--name-status', baseSnapshot, targetSnapshot], { cwd }
    ).catch(() => ({ stdout: '' }))

    const entries = nameStatus
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t')
        return { path, status: (status ?? 'M').charAt(0) }
      })
      .filter((e) => e.path)

    return Promise.all(
      entries.map(async (e) => {
        const { stdout } = await exec('git',
          ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '--git-dir', gd,
           'diff', '--no-ext-diff', '--no-renames', baseSnapshot, targetSnapshot, '--', e.path], { cwd }
        ).catch(() => ({ stdout: '' }))
        return { path: e.path, status: e.status, diff: stdout }
      }),
    )
  } finally {
    release()
  }
}

// ---- Cleanup / retention ----

/** Default age threshold for the orphan sweep: repos unused this long are pruned. */
const DEFAULT_ORPHAN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/**
 * Delete the entire sidecar snapshot repo for a workspace. Call this when the
 * workspace (or its parent project) is deleted — the cwd is gone, so its whole
 * rewind history is dead weight.
 */
export async function removeRepo(cwd: string): Promise<void> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await fs.rm(gd, { recursive: true, force: true })
    lastTreeHashCache.delete(gd)
    console.log(`[Rewind] Removed snapshot repo for ${cwd}`)
  } catch (err) {
    console.warn('[Rewind] Failed to remove snapshot repo:', err)
  } finally {
    release()
  }
}

/** Resolve when a repo dir was last used (marker file, else dir mtime). */
async function repoLastUsed(repoPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(repoPath, USED_MARKER), 'utf-8')
    const ts = parseInt(raw.trim(), 10)
    if (Number.isFinite(ts)) return ts
  } catch {
    // no marker (legacy repo) — fall back to dir mtime
  }
  try {
    const st = await fs.stat(repoPath)
    return st.mtimeMs
  } catch {
    return 0 // unreadable → treat as ancient
  }
}

/**
 * Reclaim disk by deleting sidecar repos that no longer belong to any live
 * workspace. Since every capture() cwd is a workspace `worktreePath`, a repo
 * whose directory name matches no live cwd is an orphan from a deleted
 * workspace. As a safeguard against an un-enumerated cwd source, an unmatched
 * repo is only removed when it has also been idle for `maxAgeMs`.
 *
 * @returns number of repos deleted.
 */
export async function sweepOrphans(
  liveCwds: string[],
  maxAgeMs: number = DEFAULT_ORPHAN_MAX_AGE_MS,
): Promise<number> {
  const reposRoot = path.join(dataDir, 'rewind', 'repos')
  const live = new Set(liveCwds.map((c) => path.basename(gitdir(c))))

  let entries: string[]
  try {
    entries = await fs.readdir(reposRoot)
  } catch {
    return 0 // nothing captured yet
  }

  const now = Date.now()
  let removed = 0
  for (const name of entries) {
    if (live.has(name)) continue // belongs to a live workspace
    const repoPath = path.join(reposRoot, name)
    try {
      const lastUsed = await repoLastUsed(repoPath)
      if (now - lastUsed < maxAgeMs) continue // unmatched but recently active — keep
      await fs.rm(repoPath, { recursive: true, force: true })
      lastTreeHashCache.delete(repoPath)
      removed++
    } catch {
      // skip this repo on error, continue sweeping the rest
    }
  }
  if (removed > 0) {
    console.log(`[Rewind] Orphan sweep removed ${removed} stale snapshot repo(s)`)
  }
  return removed
}

// ---- Snapshot pinning (keep only the retained snapshots on disk) ----

/**
 * Snapshots are bare `write-tree` results with no ref, so `git gc` would
 * reclaim them. We pin each retained checkpoint with a ref under
 * `refs/checkpoints/<chatId>/<hash(messageUid)>` so gc never collects it, and
 * drop the ref when the checkpoint is evicted so its objects become reclaimable.
 */
function checkpointRef(chatId: number, messageUid: string, kind: SnapshotKind = 'start'): string {
  const token = createHash('sha1').update(messageUid).digest('hex')
  // 'start' keeps the original ref name so pins written before end snapshots
  // existed stay valid.
  return kind === 'start'
    ? `refs/checkpoints/${chatId}/${token}`
    : `refs/checkpoints/${chatId}/${token}-end`
}

/** Which end of a turn's diff interval a snapshot pins. */
export type SnapshotKind = 'start' | 'end'

/** Pin a retained snapshot so `git gc` never reclaims its objects. */
export async function protectSnapshot(
  cwd: string,
  chatId: number,
  messageUid: string,
  snapshotId: string,
  kind: SnapshotKind = 'start',
): Promise<void> {
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    await exec('git', ['--git-dir', gd, 'update-ref', checkpointRef(chatId, messageUid, kind), snapshotId])
  } catch (err) {
    console.warn('[Rewind] Failed to pin snapshot:', err)
  } finally {
    release()
  }
}

/**
 * Drop the pins for evicted checkpoints and reclaim their objects in the
 * background (throttled gc). Refs that don't exist (e.g. legacy checkpoints
 * captured before pinning) are ignored.
 */
export async function releaseSnapshots(cwd: string, chatId: number, messageUids: string[]): Promise<void> {
  if (messageUids.length === 0) return
  const gd = gitdir(cwd)
  const release = await mutex.acquire(gd)
  try {
    for (const uid of messageUids) {
      await exec('git', ['--git-dir', gd, 'update-ref', '-d', checkpointRef(chatId, uid, 'start')]).catch(() => {})
      await exec('git', ['--git-dir', gd, 'update-ref', '-d', checkpointRef(chatId, uid, 'end')]).catch(() => {})
    }
  } finally {
    release()
  }
  void gcRepo(cwd)
}

/** Minimum interval between gc runs per repo, to keep gc off the hot path. */
const GC_MIN_INTERVAL_MS = 5 * 60 * 1000
const lastGcAt = new Map<string, number>()

/**
 * Reclaim objects from unpinned (evicted / legacy) snapshots. Throttled per
 * repo and run under the repo mutex. `--prune=10.minutes.ago` only removes
 * objects unreachable for >10min, so it can never race a snapshot that was just
 * captured but not yet pinned.
 */
export async function gcRepo(cwd: string): Promise<void> {
  const gd = gitdir(cwd)
  const now = Date.now()
  if (now - (lastGcAt.get(gd) ?? 0) < GC_MIN_INTERVAL_MS) return
  lastGcAt.set(gd, now)

  const release = await mutex.acquire(gd)
  try {
    await exec('git', ['--git-dir', gd, 'gc', '--quiet', '--prune=10.minutes.ago'])
  } catch (err) {
    console.warn('[Rewind] gc failed:', err)
  } finally {
    release()
  }
}
