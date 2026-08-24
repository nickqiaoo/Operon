import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

/**
 * Faithful port of Codex's `git-repo-watcher` (worker.js). It watches the git
 * internals + working tree directly so external git activity (commits, rebases,
 * fetches, edits made outside the app) is detected without polling.
 *
 * Codex's design we keep verbatim:
 *   - one watcher instance per repo, transport-agnostic (takes an `emit`
 *     callback; how the event reaches the client is the caller's concern);
 *   - single-file targets are watched via their PARENT directory plus an exact
 *     path filter — git rewrites HEAD/index/refs by writing a temp file and
 *     renaming over the target, so a watch on the file inode misses the change;
 *   - each change type has its own trailing 500ms debounce;
 *   - working-tree events accumulate the changed paths (or null = "everything")
 *     between debounce windows.
 *
 * The one deviation from Codex is structural, not behavioural: Codex runs this
 * in an Electron worker and ships events over an in-process bus. We run it in
 * the Node server, so `emit` is wired to an SSE stream by the route layer.
 */

export type GitChangeType = 'head' | 'index' | 'remote-refs' | 'working-tree'

export interface GitRepoChangedEvent {
  type: 'git-repo-changed'
  changeType: GitChangeType
  /** Repo root the watcher was started for (resolved absolute path). */
  root: string
  /** `--git-common-dir` (differs from gitDir inside worktrees/submodules). */
  commonDir: string
  /** True/false when known, null when it couldn't be determined. */
  rebaseInProgress: boolean | null
  /**
   * Only present for `working-tree`. Absolute paths that changed since the last
   * emit; omitted when a recursive/rename event forced a "everything changed".
   */
  changedPaths?: string[]
}

const DEBOUNCE_MS = 500

/** Trailing debounce — mirrors Codex's `u1(fn, 500)`. */
function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
}

interface WatchTarget {
  changeType: GitChangeType
  /** Directory actually handed to fs.watch. */
  watchPath: string
  recursive: boolean
  shouldHandleChangedPath: (absolutePath: string) => boolean
  onChange: () => void
  fsWatcher: FSWatcher | null
}

/** `child` is `dir` itself or lives underneath it. */
function isInsideDir(dir: string, child: string): boolean {
  const rel = relative(dir, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function pathExists(path: string): Promise<boolean | null> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (err != null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false
    }
    return null
  }
}

async function resolveGitDirs(
  root: string
): Promise<{ gitDir: string; commonDir: string }> {
  const { stdout } = await execAsync(
    'git rev-parse --absolute-git-dir --git-common-dir',
    { cwd: root }
  )
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const gitDir = lines[0] ?? join(root, '.git')
  let commonDir = lines[1] ?? gitDir
  if (!isAbsolute(commonDir)) commonDir = resolve(root, commonDir)
  return { gitDir, commonDir }
}

class GitRepoWatcher {
  private readonly watchTargets: WatchTarget[] = []
  private pendingWorkingTreePaths: Set<string> | null = new Set()
  private commonDir: string | null = null
  private gitDir: string | null = null
  private disposed = false

  private readonly emitHeadChangedDebounced: () => void
  private readonly emitIndexChangedDebounced: () => void
  private readonly emitRemoteRefsChangedDebounced: () => void
  private readonly emitWorkingTreeChangedDebounced: () => void

  constructor(
    private readonly root: string,
    private readonly emit: (event: GitRepoChangedEvent) => void
  ) {
    this.emitHeadChangedDebounced = debounce(() => this.emitRepoChanged('head'), DEBOUNCE_MS)
    this.emitIndexChangedDebounced = debounce(() => this.emitRepoChanged('index'), DEBOUNCE_MS)
    this.emitRemoteRefsChangedDebounced = debounce(() => this.emitRepoChanged('remote-refs'), DEBOUNCE_MS)
    this.emitWorkingTreeChangedDebounced = debounce(() => this.emitRepoChanged('working-tree'), DEBOUNCE_MS)
  }

  async start(): Promise<void> {
    const { gitDir, commonDir } = await resolveGitDirs(this.root)
    this.gitDir = gitDir
    this.commonDir = commonDir

    this.tryWatchFile(join(gitDir, 'HEAD'), 'head', this.emitHeadChangedDebounced)
    this.tryWatchFile(join(gitDir, 'index'), 'index', this.emitIndexChangedDebounced)
    this.tryWatchFile(join(commonDir, 'FETCH_HEAD'), 'remote-refs', this.emitRemoteRefsChangedDebounced)
    this.tryWatchFile(join(commonDir, 'packed-refs'), 'remote-refs', this.emitRemoteRefsChangedDebounced)
    this.tryWatchDirectory(
      this.root,
      'working-tree',
      this.emitWorkingTreeChangedDebounced,
      (changedPath) => !this.isGitInternalPath(changedPath)
    )
  }

  dispose(): void {
    this.disposed = true
    for (const target of this.watchTargets) {
      target.fsWatcher?.close()
      target.fsWatcher = null
    }
    this.watchTargets.length = 0
  }

  private tryWatchFile(
    filePath: string,
    changeType: GitChangeType,
    onChange: () => void
  ): void {
    const target: WatchTarget = {
      changeType,
      watchPath: dirname(filePath),
      recursive: false,
      shouldHandleChangedPath: (changedPath) => changedPath === filePath,
      onChange,
      fsWatcher: null,
    }
    this.watchTargets.push(target)
    this.startLocalWatch(target)
  }

  private tryWatchDirectory(
    dir: string,
    changeType: GitChangeType,
    onChange: () => void,
    shouldHandleChangedPath: (absolutePath: string) => boolean
  ): void {
    const target: WatchTarget = {
      changeType,
      watchPath: dir,
      recursive: true,
      shouldHandleChangedPath,
      onChange,
      fsWatcher: null,
    }
    this.watchTargets.push(target)
    this.startLocalWatch(target)
  }

  private startLocalWatch(target: WatchTarget): void {
    try {
      const watcher = watch(
        target.watchPath,
        { recursive: target.recursive },
        (_event, filename) => {
          if (filename == null) {
            this.handleFileWatchEvent(target)
            return
          }
          const changedPath = resolve(target.watchPath, filename.toString())
          if (target.shouldHandleChangedPath(changedPath)) {
            this.handleFileWatchEvent(target, [changedPath])
          }
        }
      )
      target.fsWatcher = watcher
      watcher.on('error', (error) => {
        console.warn('[git-repo-watcher] watch failed', target.watchPath, error)
        watcher.close()
        if (target.fsWatcher === watcher) target.fsWatcher = null
      })
    } catch (error) {
      // Notably, fs.watch({recursive}) is unsupported on Linux — the working-
      // tree target fails here while the single-file targets keep working, so
      // commits/fetches are still detected. Matches Codex's best-effort start.
      console.warn('[git-repo-watcher] failed to watch', target.watchPath, error)
    }
  }

  private handleFileWatchEvent(target: WatchTarget, changedPaths?: string[]): void {
    if (target.changeType === 'working-tree') {
      if (changedPaths == null) {
        this.pendingWorkingTreePaths = null
      } else if (this.pendingWorkingTreePaths != null) {
        for (const changedPath of changedPaths) {
          this.pendingWorkingTreePaths.add(changedPath)
        }
      }
    }
    target.onChange()
  }

  private async emitRepoChanged(changeType: GitChangeType): Promise<void> {
    if (this.disposed) return

    let changedPaths: string[] | undefined
    if (changeType === 'working-tree') {
      changedPaths =
        this.pendingWorkingTreePaths != null
          ? [...this.pendingWorkingTreePaths]
          : undefined
      this.pendingWorkingTreePaths = new Set()
    }

    const rebaseInProgress = await this.getRebaseInProgress()
    if (this.disposed) return

    this.emit({
      type: 'git-repo-changed',
      changeType,
      root: this.root,
      commonDir: this.commonDir ?? this.root,
      rebaseInProgress,
      ...(changedPaths == null ? {} : { changedPaths }),
    })
  }

  /** Mirror of Codex's rebase detection (REBASE_HEAD / rebase-merge / rebase-apply). */
  private async getRebaseInProgress(): Promise<boolean | null> {
    const dir = this.gitDir
    if (dir == null) return null
    const checks = await Promise.all([
      pathExists(join(dir, 'REBASE_HEAD')),
      pathExists(join(dir, 'rebase-merge')),
      pathExists(join(dir, 'rebase-apply')),
    ])
    if (checks.some((c) => c === true)) return true
    if (checks.some((c) => c == null)) return null
    return false
  }

  private isGitInternalPath(changedPath: string): boolean {
    if (this.commonDir != null && isInsideDir(this.commonDir, changedPath)) return true
    return isInsideDir(join(this.root, '.git'), changedPath)
  }
}

// ---------------------------------------------------------------------------
// Per-root registry + global listener fan-out. This is the thin glue between
// the watcher instances and the SSE route; the watcher class above stays pure.

interface RegistryEntry {
  watcher: GitRepoWatcher
  refCount: number
}

const entries = new Map<string, RegistryEntry>()
const listeners = new Set<(event: GitRepoChangedEvent) => void>()

function broadcast(event: GitRepoChangedEvent): void {
  for (const listener of listeners) listener(event)
}

export function addEventListener(
  listener: (event: GitRepoChangedEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Start (or ref-count) a watcher for `root`. Safe to call repeatedly. */
export async function watchRepo(root: string): Promise<void> {
  const key = resolve(root)
  const existing = entries.get(key)
  if (existing) {
    existing.refCount += 1
    return
  }
  const watcher = new GitRepoWatcher(key, broadcast)
  // Register before start() so a concurrent watchRepo ref-counts the same one.
  entries.set(key, { watcher, refCount: 1 })
  try {
    await watcher.start()
  } catch (error) {
    console.warn('[git-repo-watcher] failed to start for', key, error)
    entries.delete(key)
    watcher.dispose()
    throw error
  }
}

/** Release one reference; disposes the watcher when the last consumer leaves. */
export function unwatchRepo(root: string): void {
  const key = resolve(root)
  const entry = entries.get(key)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount <= 0) {
    entry.watcher.dispose()
    entries.delete(key)
  }
}
