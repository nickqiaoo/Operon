import { exec } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import simpleGit, { type StatusResult } from 'simple-git'
import type { GitFileStatus, GitStatusSummary, GitWorktreeEntry } from '../types/git.js'

const execAsync = promisify(exec)

async function moveToTrash(filePath: string): Promise<void> {
  const absPath = resolve(filePath)
  if (process.platform === 'darwin') {
    await execAsync(`osascript -e 'tell application "Finder" to delete POSIX file "${absPath}"'`)
  } else if (process.platform === 'win32') {
    // PowerShell recycle bin
    await execAsync(`powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${absPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`)
  } else {
    // Linux fallback: gio trash or direct delete
    try {
      await execAsync(`gio trash "${absPath}"`)
    } catch {
      await unlink(absPath)
    }
  }
}

const normalizeStatus = (index: string, workingDir: string) => {
  const indexCode = index.trim()
  const workingCode = workingDir.trim()
  return indexCode || workingCode || ' '
}

const isNestedGitRepo = (repoPath: string, relativePath: string): boolean => {
  try {
    const cleanPath = relativePath.replace(/[\\/]+$/, '')
    const fullPath = join(repoPath, cleanPath)
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return false
    return existsSync(join(fullPath, '.git'))
  } catch {
    return false
  }
}

const buildStatusSummary = (status: StatusResult, repoPath: string): GitStatusSummary => {
  const files: GitFileStatus[] = []
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []
  const untracked: GitFileStatus[] = []

  status.files.forEach((file) => {
    if (file.index === '?' && file.working_dir === '?' && isNestedGitRepo(repoPath, file.path)) {
      return
    }

    const entry: GitFileStatus = {
      path: file.path,
      status: normalizeStatus(file.index, file.working_dir),
      index: file.index,
      workingDir: file.working_dir,
    }
    files.push(entry)

    if (file.index.trim() && file.index !== '?') {
      staged.push(entry)
    }
    if (file.working_dir.trim() && file.working_dir !== '?') {
      unstaged.push(entry)
    }
    if (file.index === '?' || file.working_dir === '?') {
      untracked.push(entry)
    }
  })

  return {
    current: status.current ?? null,
    ahead: status.ahead,
    behind: status.behind,
    files,
    staged,
    unstaged,
    untracked,
  }
}

const parseWorktreeList = (output: string): GitWorktreeEntry[] => {
  const lines = output.split(/\r?\n/)
  const entries: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null

  const pushCurrent = () => {
    if (current?.path) {
      entries.push(current)
    }
    current = null
  }

  for (const line of lines) {
    if (!line.trim()) {
      pushCurrent()
      continue
    }
    if (line.startsWith('worktree ')) {
      pushCurrent()
      current = {
        path: line.replace('worktree ', '').trim(),
        branch: null,
        head: null,
        detached: false,
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) {
      current.head = line.replace('HEAD ', '').trim()
      continue
    }
    if (line.startsWith('branch ')) {
      current.branch = line.replace('branch ', '').trim()
      continue
    }
    if (line.startsWith('detached')) {
      current.detached = true
    }
  }

  pushCurrent()
  return entries
}

// Cache git instances to avoid repeated checkIsRepo calls
const gitCache = new Map<string, ReturnType<typeof simpleGit>>()
const gitVerified = new Set<string>()

function getGit(repoPath: string) {
  let git = gitCache.get(repoPath)
  if (!git) {
    // `core.quotepath=false`: emit non-ASCII paths (e.g. Chinese filenames) as raw UTF-8
    // instead of git's default octal-escaped `"\351\243\216…"` quoting, which leaks into
    // numstat/name-status/diff parsing and renders as gibberish in the diff card.
    git = simpleGit({ baseDir: repoPath, config: ['core.quotepath=false'] })
    gitCache.set(repoPath, git)
  }
  return git
}

const nonRepoCache = new Set<string>()

async function ensureRepo(repoPath: string) {
  if (nonRepoCache.has(repoPath)) return null
  const git = getGit(repoPath)
  if (!gitVerified.has(repoPath)) {
    const isRepo = await git.checkIsRepo()
    if (!isRepo) {
      nonRepoCache.add(repoPath)
      return null
    }
    gitVerified.add(repoPath)
  }
  return git
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  return git !== null
}

const emptyStatus: GitStatusSummary = {
  current: null, ahead: 0, behind: 0,
  files: [], staged: [], unstaged: [], untracked: [],
}

export async function getStatus(repoPath: string): Promise<GitStatusSummary> {
  const git = await ensureRepo(repoPath)
  if (!git) return emptyStatus
  const status = await git.status()
  return buildStatusSummary(status, repoPath)
}

export async function getDiff(repoPath: string, file?: string, cached = false): Promise<string> {
  const git = await ensureRepo(repoPath)
  if (!git) return ''
  const args: string[] = []
  if (cached) args.push('--cached')
  if (file) args.push('--', file)
  return git.diff(args)
}

/**
 * Read a file at a specific git ref (e.g. HEAD, branch, sha) via `git show ref:path`.
 * Returns empty string if the file didn't exist at that ref or the repo is invalid.
 */
export async function gitShow(
  repoPath: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const git = await ensureRepo(repoPath)
  if (!git) return ''
  try {
    return await git.raw(['show', `${ref}:${filePath}`])
  } catch {
    // `git show ref:path` errors when the file doesn't exist at that ref
    // (e.g. newly-added files). Callers treat empty string as "no prior content".
    return ''
  }
}

/** List file paths (repo-root-relative) under `dir` at `ref`; empty if the dir is absent there. */
export async function listTreeFiles(repoPath: string, ref: string, dir: string): Promise<string[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  try {
    const out = await git.raw(['ls-tree', '--name-only', '-r', ref, `${dir}/`])
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function stage(repoPath: string, filePath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  await git.add(['--', filePath])
  return true
}

export async function stageAll(repoPath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  await git.add(['-A'])
  return true
}

export async function unstage(repoPath: string, filePath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  await git.raw(['reset', 'HEAD', '--', filePath])
  return true
}

export async function unstageAll(repoPath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  await git.raw(['reset', 'HEAD', '--', '.'])
  return true
}

export async function worktreeList(repoPath: string): Promise<GitWorktreeEntry[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  const output = await git.raw(['worktree', 'list', '--porcelain'])
  return parseWorktreeList(output)
}

export async function worktreeAdd(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  createBranch = true,
  source?: string
): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  const args = ['worktree', 'add']
  if (createBranch) {
    args.push('-b', branchName)
    args.push(worktreePath)
    if (source) args.push(source)
  } else {
    args.push(worktreePath, branchName)
  }
  await git.raw(args)
  return true
}

export async function worktreeRemove(repoPath: string, worktreePath: string, force = false): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  await git.raw(args)
  return true
}

export interface DiffStatEntry {
  additions: number
  deletions: number
}

export type DiffStatMap = Record<string, DiffStatEntry>

function parseNumstat(output: string): DiffStatMap {
  const result: DiffStatMap = {}
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [add, del] = parts
    // Renames/copies: `add\tdel\told\tnew` — prefer the new path (matches name-status).
    // Plain paths may also appear as `old => new` in a single field.
    const rawPath =
      parts.length >= 4 ? parts[parts.length - 1] : (parts[2] ?? '')
    const file = rawPath.includes(' => ')
      ? rawPath.slice(rawPath.lastIndexOf(' => ') + 4).trim()
      : rawPath
    if (!file) continue
    result[file] = {
      additions: add === '-' ? 0 : Number(add) || 0,
      deletions: del === '-' ? 0 : Number(del) || 0,
    }
  }
  return result
}

const emptyDiffStat = { staged: {} as DiffStatMap, unstaged: {} as DiffStatMap }

export async function getDiffStat(repoPath: string): Promise<{ staged: DiffStatMap; unstaged: DiffStatMap }> {
  const git = await ensureRepo(repoPath)
  if (!git) return emptyDiffStat
  const [stagedOutput, unstagedOutput] = await Promise.all([
    git.diff(['--cached', '--numstat']),
    git.diff(['--numstat']),
  ])
  return {
    staged: parseNumstat(stagedOutput),
    unstaged: parseNumstat(unstagedOutput),
  }
}

export async function getStatusWithDiffStat(repoPath: string): Promise<{ status: GitStatusSummary; diffStat: { staged: DiffStatMap; unstaged: DiffStatMap } }> {
  const git = await ensureRepo(repoPath)
  if (!git) return { status: emptyStatus, diffStat: emptyDiffStat }
  const [status, stagedOutput, unstagedOutput] = await Promise.all([
    git.status(),
    git.diff(['--cached', '--numstat']),
    git.diff(['--numstat']),
  ])
  return {
    status: buildStatusSummary(status, repoPath),
    diffStat: {
      staged: parseNumstat(stagedOutput),
      unstaged: parseNumstat(unstagedOutput),
    },
  }
}

export async function listRemotes(repoPath: string): Promise<{ name: string; url: string }[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  const remotes = await git.getRemotes(true)
  return remotes.map((r) => ({ name: r.name, url: r.refs.push || r.refs.fetch || '' }))
}

/** git's empty-tree object — used as the "parent" of a root commit. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** merge-base between a ref and HEAD; null when they share no history. */
export async function getMergeBase(repoPath: string, ref: string): Promise<string | null> {
  const git = await ensureRepo(repoPath)
  if (!git) return null
  try {
    return (await git.raw(['merge-base', ref, 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

/**
 * Default base branch for the "Branch" review scope: the remote's default
 * branch (origin/HEAD) when known, else the current branch's upstream, else a
 * conventional origin/main / origin/master. Returns null when no remote.
 */
export async function getDefaultBaseBranch(repoPath: string): Promise<string | null> {
  const git = await ensureRepo(repoPath)
  if (!git) return null
  const remotes = await git.getRemotes(false)
  const remote = remotes[0]?.name
  if (!remote) return null
  try {
    const head = (await git.raw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim()
    if (head) return head
  } catch {
    /* origin/HEAD not set — fall through */
  }
  try {
    const upstream = (await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
    if (upstream) return upstream
  } catch {
    /* no upstream — fall through */
  }
  for (const candidate of [`${remote}/main`, `${remote}/master`]) {
    try {
      await git.raw(['rev-parse', '--verify', '--quiet', candidate])
      return candidate
    } catch {
      /* not present */
    }
  }
  return null
}

export interface BranchEntry {
  name: string
  current: boolean
  remote: boolean
}

/** Local + remote branches for the branch picker (skips remote HEAD aliases). */
export async function listBranches(repoPath: string): Promise<BranchEntry[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  const summary = await git.branch(['-a'])
  const entries: BranchEntry[] = []
  for (const raw of summary.all) {
    // Skip symbolic aliases like "remotes/origin/HEAD -> origin/main".
    if (raw.includes('->') || raw.endsWith('/HEAD')) continue
    const remote = raw.startsWith('remotes/')
    const name = remote ? raw.slice('remotes/'.length) : raw
    entries.push({ name, current: raw === summary.current, remote })
  }
  return entries
}

export interface CommitEntry {
  sha: string
  shortSha: string
  subject: string
  relativeTime: string
  authorName: string
}

/** Recent commits on HEAD for the commit-scope picker. */
export async function listCommits(repoPath: string, limit = 50): Promise<CommitEntry[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  const out = await git.raw([
    'log',
    `-n${limit}`,
    '--pretty=format:%H%x00%h%x00%s%x00%cr%x00%an',
  ])
  const commits: CommitEntry[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [sha, shortSha, subject, relativeTime, authorName] = line.split('\x00')
    if (!sha) continue
    commits.push({ sha, shortSha, subject, relativeTime, authorName })
  }
  return commits
}

export interface RangeFileEntry {
  path: string
  status: string
  /** Line stats from `git diff --numstat` (authoritative; matches Codex). */
  additions: number
  deletions: number
}

const parseNameStatus = (raw: string): Array<{ path: string; status: string }> => {
  const files: Array<{ path: string; status: string }> = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]?.trim() ?? ''
    // Renames/copies come as `R100\told\tnew` — take the new path.
    const path = parts.length >= 3 ? parts[2] : parts[1]
    if (!path) continue
    files.push({ path, status: code.charAt(0) || 'M' })
  }
  return files
}

/**
 * Changed files between two refs. When `headRef` is null the base is compared
 * against the working tree (used by the branch scope: base = merge-base).
 *
 * Line counts come from `--numstat` (same source Codex uses for the +N/-N
 * header), not from parsing unified diffs — per-file patch load can fail or
 * under-count binary / special-path files.
 */
export async function getDiffRange(
  repoPath: string,
  baseRef: string,
  headRef?: string | null,
): Promise<RangeFileEntry[]> {
  const git = await ensureRepo(repoPath)
  if (!git) return []
  const nameArgs = ['diff', '--name-status', baseRef]
  const statArgs = ['diff', '--numstat', baseRef]
  if (headRef) {
    nameArgs.push(headRef)
    statArgs.push(headRef)
  }
  const [nameRaw, numstatRaw] = await Promise.all([
    git.raw(nameArgs),
    git.raw(statArgs),
  ])
  const stats = parseNumstat(numstatRaw)
  return parseNameStatus(nameRaw).map((entry) => {
    const stat = stats[entry.path]
    return {
      path: entry.path,
      status: entry.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
    }
  })
}

/**
 * Unified diff between two refs (headRef null = working tree). With `file`, the
 * diff is scoped to that path; without it, the whole combined patch for the
 * range is returned in one call (the review splits it per file client-side).
 */
export async function getFileDiffRange(
  repoPath: string,
  file: string | undefined,
  baseRef: string,
  headRef?: string | null,
): Promise<string> {
  const git = await ensureRepo(repoPath)
  if (!git) return ''
  const args = ['diff', baseRef]
  if (headRef) args.push(headRef)
  if (file) args.push('--', file)
  try {
    return await git.raw(args)
  } catch {
    return ''
  }
}

/** Parent sha of a commit, or the empty-tree sha for a root commit. */
export async function getCommitParentSha(repoPath: string, sha: string): Promise<string> {
  const git = await ensureRepo(repoPath)
  if (!git) return EMPTY_TREE_SHA
  try {
    return (await git.raw(['rev-parse', '--verify', '--quiet', `${sha}^`])).trim() || EMPTY_TREE_SHA
  } catch {
    return EMPTY_TREE_SHA
  }
}

export async function commit(
  repoPath: string,
  message: string,
  options?: { includeUnstaged?: boolean }
): Promise<string> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  // `includeUnstaged` mirrors Codex's commit modal toggle: stage everything
  // (tracked edits + untracked) before committing. When off we commit only
  // what's already staged.
  if (options?.includeUnstaged) {
    await git.add(['-A'])
  }
  const result = await git.commit(message)
  return result.commit
}

/** Thrown when a merge hits conflicts; the merge is aborted first, so the worktree is left clean. */
export class MergeConflictError extends Error {
  constructor(
    public readonly branch: string,
    public readonly files: string[],
  ) {
    super(`Merge of ${branch} hit conflicts in: ${files.join(', ') || 'unknown files'}`)
    this.name = 'MergeConflictError'
  }
}

/**
 * Merge `branch` into whatever is checked out at `worktreePath` (`git merge
 * --no-ff`). On conflict the merge is aborted — working tree left clean — and a
 * MergeConflictError is thrown listing the conflicted files. Conflicts are
 * surfaced to a human, never auto-resolved (§17.4). Returns the merge commit sha.
 */
export async function mergeBranch(
  worktreePath: string,
  branch: string,
  message?: string,
): Promise<string> {
  const git = await ensureRepo(worktreePath)
  if (!git) throw new Error('Not a git repository')
  try {
    await git.raw(['merge', '--no-ff', '-m', message ?? `Merge ${branch}`, branch])
  } catch (err) {
    let files: string[] = []
    try {
      const out = await git.raw(['diff', '--name-only', '--diff-filter=U'])
      files = out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      // ignore — best-effort conflict file list
    }
    try {
      await git.raw(['merge', '--abort'])
    } catch {
      // ignore — nothing to abort
    }
    if (files.length > 0) throw new MergeConflictError(branch, files)
    throw err instanceof Error ? err : new Error(String(err))
  }
  return (await git.revparse(['HEAD'])).trim()
}

export type PushErrorCode =
  | 'no-remote'
  | 'no-upstream'
  | 'rejected'
  | 'remote-changed'
  | 'auth'
  | 'unknown'

export class PushError extends Error {
  code: PushErrorCode
  constructor(code: PushErrorCode, message: string) {
    super(message)
    this.name = 'PushError'
    this.code = code
  }
}

/** Map raw git push stderr/stdout into one of our coarse error codes. */
function classifyPushError(output: string): PushErrorCode {
  const text = output.toLowerCase()
  if (/has no upstream branch|set-upstream|no upstream configured/.test(text)) {
    return 'no-upstream'
  }
  if (/non-fast-forward|fetch first|tip of your current branch is behind|\(non-fast-forward\)/.test(text)) {
    return 'rejected'
  }
  if (/stale info|stale info; you may need to fetch|cannot lock ref|remote ref .* changed/.test(text)) {
    return 'remote-changed'
  }
  if (/authentication failed|could not read username|permission denied|access denied|403|fatal: could not read/.test(text)) {
    return 'auth'
  }
  return 'unknown'
}

/**
 * Resolve which remote a push should target. Mirrors Codex's `zk`: prefer the
 * current branch's upstream remote, otherwise fall back to the first configured
 * remote. Returns null when the repo has no remotes at all.
 */
async function resolvePushRemote(git: ReturnType<typeof simpleGit>): Promise<string | null> {
  try {
    const upstream = (
      await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim()
    // e.g. "origin/main" → remote is the segment before the first slash.
    const slash = upstream.indexOf('/')
    if (slash > 0) return upstream.slice(0, slash)
  } catch {
    // No upstream configured yet — fall through to the first remote.
  }
  const remotes = await git.getRemotes(false)
  return remotes[0]?.name ?? null
}

export async function getPushStatus(repoPath: string): Promise<{
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasRemote: boolean
  remote: string | null
}> {
  const git = await ensureRepo(repoPath)
  if (!git) {
    return { branch: null, upstream: null, ahead: 0, behind: 0, hasRemote: false, remote: null }
  }
  const status = await git.status()
  let upstream: string | null = null
  try {
    upstream = (
      await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim() || null
  } catch {
    upstream = null
  }
  const remote = await resolvePushRemote(git)
  return {
    branch: status.current ?? null,
    upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote: remote != null,
    remote,
  }
}

export async function push(
  repoPath: string,
  options?: { setUpstream?: boolean; force?: boolean }
): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')

  const remote = await resolvePushRemote(git)
  if (!remote) {
    throw new PushError('no-remote', 'No git remote configured for push')
  }

  const status = await git.status()
  const branch = status.current
  const hasUpstream = await git
    .raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    .then(() => true)
    .catch(() => false)

  const args: string[] = ['push']
  if (options?.force) args.push('--force-with-lease')
  // Set upstream on the first push of a branch (or when explicitly requested).
  if (options?.setUpstream || !hasUpstream) {
    args.push('-u', remote)
    if (branch) args.push(branch)
  }

  try {
    await git.raw(args)
    return true
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    throw new PushError(classifyPushError(output), output)
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  const git = await ensureRepo(repoPath)
  if (!git) return null
  const status = await git.status()
  return status.current ?? null
}

export async function checkoutNewBranch(repoPath: string, branchName: string): Promise<void> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  await git.checkoutLocalBranch(branchName)
}

export async function pushBranch(
  repoPath: string,
  remote: string,
  branchName: string,
  setUpstream = true,
): Promise<void> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  const args = setUpstream ? ['-u', remote, branchName] : [remote, branchName]
  await git.push(args)
}

export async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) return false
  const branches = await git.branchLocal()
  return branches.all.includes(branchName)
}

/**
 * Force-delete a local branch. Used for throwaway branches that must be re-cut
 * from a moved base rather than reused (e.g. a verification checkout). Returns
 * false when the branch isn't there — deleting nothing is not an error.
 */
export async function deleteLocalBranch(repoPath: string, branchName: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) return false
  const branches = await git.branchLocal()
  if (!branches.all.includes(branchName)) return false
  await git.raw(['branch', '-D', branchName])
  return true
}

export async function restore(repoPath: string, filePath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  const status = await git.status()
  const isUntracked = status.not_added.includes(filePath)
  if (isUntracked) {
    await moveToTrash(join(repoPath, filePath))
  } else {
    await git.raw(['restore', '--', filePath])
  }
  return true
}

/**
 * Revert every *unstaged* change: restore tracked working-tree modifications/
 * deletions from the index, and move untracked files to the trash. Mirrors the
 * per-file `restore` applied across the whole working tree (the "Revert all"
 * action). Staged changes are left intact.
 */
export async function restoreAll(repoPath: string): Promise<boolean> {
  const git = await ensureRepo(repoPath)
  if (!git) throw new Error('Not a git repository')
  const status = await git.status()

  // Tracked paths with an unstaged working-tree change ('M', 'D', …; '?' = untracked).
  const tracked = status.files
    .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
    .map((f) => f.path)
  if (tracked.length > 0) {
    await git.raw(['restore', '--', ...tracked])
  }

  for (const path of status.not_added) {
    await moveToTrash(join(repoPath, path))
  }
  return true
}
