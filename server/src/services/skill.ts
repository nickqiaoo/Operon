/**
 * Embedded skills manager — adapted from vercel-labs/skills (MIT).
 *
 * Supports 5 operations on global skills (~/.agents/skills/):
 *   - listInstalledSkills   — scan installed skills
 *   - listAvailableSkills   — clone repo and discover SKILL.md files
 *   - getSkillDetail        — read one skill's SKILL.md + bundled files (preview)
 *   - installSkill          — clone repo, copy skill to ~/.agents/skills/
 *   - removeSkill           — delete skill directory and update lock file
 *
 * No CLI subprocess, no node binary required.
 */

import { existsSync } from 'fs'
import { readdir, readFile, writeFile, stat, mkdir, cp, rm, access } from 'fs/promises'
import { join, dirname, resolve, normalize, sep, relative } from 'path'
import { homedir, tmpdir } from 'os'
import { mkdtemp } from 'fs/promises'
import { createHash } from 'crypto'
import simpleGit from 'simple-git'
import matter from 'gray-matter'
import type {
  InstalledSkill,
  SkillDetail,
  SkillFile,
  SkillInfo,
  SkillInstallResult,
  SkillInstallTargetResult,
  SkillScope,
  SkillUpdateResult,
} from '../types/skill.js'
import { OPERON_DATA_DIR } from './operon-runtime/paths.js'
import {
  canonicalSkillsDir,
  copyDirectory,
  linkIntoTarget,
  resolveExistingTargets,
  resolveInstallTargets,
  type ScopeContext,
} from './skill-targets.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS_DIR = '.agents'
const CLONE_TIMEOUT_MS = 60_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__'])
const LOCK_FILE = '.skill-lock.json'
/** v4 added `targets`; v3 entries are migrated in place rather than discarded. */
const LOCK_VERSION = 4
const MIN_READABLE_LOCK_VERSION = 3
/** Cloned source repos live here, one per url+ref, shared by browse / preview / install. */
const REPO_CACHE_ROOT = join(OPERON_DATA_DIR, 'skill-repo-cache')
const REPO_CACHE_TTL_MS = 6 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Source parser (from source-parser.ts)
// ---------------------------------------------------------------------------

interface ParsedSource {
  type: 'github' | 'gitlab' | 'git' | 'local'
  url: string
  subpath?: string
  localPath?: string
  ref?: string
  skillFilter?: string
}

function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, '/')
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw new Error(`Unsafe subpath: "${subpath}" contains path traversal segments.`)
    }
  }
  return subpath
}

function isLocalPath(input: string): boolean {
  return (
    resolve(input) === resolve(input) && (
      input.startsWith('/') ||
      input.startsWith('./') ||
      input.startsWith('../') ||
      input === '.' ||
      input === '..'
    )
  )
}

function parseSource(input: string): ParsedSource {
  // Local path
  if (isLocalPath(input)) {
    const resolvedPath = resolve(input)
    return { type: 'local', url: resolvedPath, localPath: resolvedPath }
  }

  // GitHub URL with path: https://github.com/owner/repo/tree/branch/path
  const githubTreeWithPathMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/)
  if (githubTreeWithPathMatch) {
    const [, owner, repo, ref, subpath] = githubTreeWithPathMatch
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ref,
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    }
  }

  // GitHub URL with branch: https://github.com/owner/repo/tree/branch
  const githubTreeMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)$/)
  if (githubTreeMatch) {
    const [, owner, repo, ref] = githubTreeMatch
    return { type: 'github', url: `https://github.com/${owner}/${repo}.git`, ref }
  }

  // GitHub URL: https://github.com/owner/repo
  const githubRepoMatch = input.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (githubRepoMatch) {
    const [, owner, repo] = githubRepoMatch
    const cleanRepo = repo!.replace(/\.git$/, '')
    return { type: 'github', url: `https://github.com/${owner}/${cleanRepo}.git` }
  }

  // GitLab URL
  const gitlabRepoMatch = input.match(/gitlab\.com\/(.+?)(?:\.git)?\/?$/)
  if (gitlabRepoMatch) {
    const repoPath = gitlabRepoMatch[1]!
    if (repoPath.includes('/')) {
      return { type: 'gitlab', url: `https://gitlab.com/${repoPath}.git` }
    }
  }

  // GitHub shorthand with @skill: owner/repo@skill-name
  const atSkillMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/)
  if (atSkillMatch && !input.includes(':') && !input.startsWith('.') && !input.startsWith('/')) {
    const [, owner, repo, skillFilter] = atSkillMatch
    return { type: 'github', url: `https://github.com/${owner}/${repo}.git`, skillFilter }
  }

  // GitHub shorthand: owner/repo or owner/repo/subpath
  const shorthandMatch = input.match(/^([^/]+)\/([^/]+)(?:\/(.+))?$/)
  if (shorthandMatch && !input.includes(':') && !input.startsWith('.') && !input.startsWith('/')) {
    const [, owner, repo, subpath] = shorthandMatch
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    }
  }

  // Fallback: direct git URL
  return { type: 'git', url: assertSafeGitUrl(input) }
}

/**
 * Only let known-good transports through.
 *
 * Git's `ext::` transport runs an arbitrary command, and remote helpers of the form
 * `<helper>::<payload>` are equally executable — cloning a user-supplied string is
 * enough to get code execution. Allow-list rather than block-list: upstream tried
 * blocking and had to revert it when the patterns caught legitimate URLs too.
 */
function assertSafeGitUrl(input: string): string {
  const url = input.trim()

  // scp-like syntax: user@host:path — no scheme, and the colon is a path separator.
  if (/^[\w.-]+@[\w.-]+:[^:]/.test(url)) return url

  const scheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)?.[1]?.toLowerCase()
  const ALLOWED = new Set(['https', 'http', 'ssh', 'git'])
  if (scheme && ALLOWED.has(scheme)) return url

  throw new Error(
    `Unsupported skill source "${input}". Use an owner/repo shorthand, an https/ssh git URL, or a local path.`,
  )
}

// ---------------------------------------------------------------------------
// Git (from git.ts)
// ---------------------------------------------------------------------------

async function cloneRepo(url: string, ref?: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'skills-'))
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } })
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1']
  // Disable interactive git prompts
  process.env.GIT_TERMINAL_PROMPT = '0'

  try {
    await git.clone(url, tempDir, cloneOptions)
    return tempDir
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to clone ${url}: ${msg}`)
  }
}

async function cleanupTempDir(dir: string): Promise<void> {
  const normalizedDir = normalize(resolve(dir))
  const normalizedTmpDir = normalize(resolve(tmpdir()))
  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error('Attempted to clean up directory outside of temp directory')
  }
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Cached source repos
// ---------------------------------------------------------------------------
// Browsing, previewing and installing all need the same repo on disk. Cloning per
// request made every click cost a full network round-trip, so each url+ref is cloned
// once into the cache and reused until the TTL expires (or the user hits Refresh).

/** In-flight clones, so concurrent callers on the same key share one clone. */
const repoCacheInflight = new Map<string, Promise<string>>()

function repoCacheKey(url: string, ref?: string): string {
  const digest = createHash('sha256').update(`${url}#${ref ?? 'HEAD'}`).digest('hex').slice(0, 16)
  const readable = url.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/[^\w.-]/g, '_').slice(0, 60)
  return `${readable}-${digest}`
}

async function ensureSourceRepo(url: string, ref: string | undefined, refresh: boolean): Promise<string> {
  const key = repoCacheKey(url, ref)
  const inflight = repoCacheInflight.get(key)
  if (inflight && !refresh) return inflight

  const dest = join(REPO_CACHE_ROOT, key)
  const metaPath = join(REPO_CACHE_ROOT, `${key}.json`)

  if (!refresh) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { at: number }
      if (Date.now() - meta.at < REPO_CACHE_TTL_MS) {
        await access(dest)
        return dest
      }
    } catch {
      // missing / stale / corrupt cache → clone below
    }
  }

  const task = (async () => {
    const fresh = await cloneRepo(url, ref)
    await mkdir(REPO_CACHE_ROOT, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    try {
      await cp(fresh, dest, { recursive: true })
      await writeFile(metaPath, JSON.stringify({ url, ref: ref ?? null, at: Date.now() }), 'utf-8')
    } finally {
      await cleanupTempDir(fresh).catch(() => {})
    }
    return dest
  })()

  repoCacheInflight.set(key, task)
  try {
    return await task
  } finally {
    repoCacheInflight.delete(key)
  }
}

/**
 * Local dir holding the source's files. Remote sources resolve to the shared cache,
 * so callers must NOT delete the returned directory.
 */
async function resolveSourceDir(parsed: ParsedSource, refresh = false): Promise<string> {
  if (parsed.type === 'local') {
    const localPath = parsed.localPath!
    if (!existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${localPath}`)
    }
    return localPath
  }
  return ensureSourceRepo(parsed.url, parsed.ref, refresh)
}

// ---------------------------------------------------------------------------
// Skill discovery (from skills.ts)
// ---------------------------------------------------------------------------

interface Skill {
  name: string
  description: string
  path: string
  rawContent?: string
  pluginName?: string
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    const stats = await stat(join(dir, 'SKILL.md'))
    return stats.isFile()
  } catch {
    return false
  }
}

async function parseSkillMd(skillMdPath: string): Promise<Skill | null> {
  try {
    const content = await readFile(skillMdPath, 'utf-8')
    const { data } = matter(content)
    if (!data.name || !data.description) return null
    if (typeof data.name !== 'string' || typeof data.description !== 'string') return null
    // Skip internal skills
    if (data.metadata?.internal === true) return null
    return {
      name: data.name,
      description: data.description,
      path: dirname(skillMdPath),
      rawContent: content,
    }
  } catch {
    return null
  }
}

async function findSkillDirs(dir: string, depth = 0, maxDepth = 5): Promise<string[]> {
  if (depth > maxDepth) return []
  try {
    const [hasSkill, entries] = await Promise.all([
      hasSkillMd(dir),
      readdir(dir, { withFileTypes: true }).catch(() => []),
    ])
    const currentDir = hasSkill ? [dir] : []
    const subDirResults = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
        .map((entry) => findSkillDirs(join(dir, entry.name), depth + 1, maxDepth)),
    )
    return [...currentDir, ...subDirResults.flat()]
  } catch {
    return []
  }
}

function isSubpathSafe(basePath: string, subpath: string): boolean {
  const normalizedBase = normalize(resolve(basePath))
  const normalizedTarget = normalize(resolve(join(basePath, subpath)))
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase
}

async function discoverSkills(basePath: string, subpath?: string): Promise<Skill[]> {
  const skills: Skill[] = []
  const seenNames = new Set<string>()

  if (subpath && !isSubpathSafe(basePath, subpath)) {
    throw new Error(`Invalid subpath: "${subpath}" resolves outside the repository directory.`)
  }

  const searchPath = subpath ? join(basePath, subpath) : basePath

  // If pointing directly at a skill
  if (await hasSkillMd(searchPath)) {
    const skill = await parseSkillMd(join(searchPath, 'SKILL.md'))
    if (skill) {
      skills.push(skill)
      seenNames.add(skill.name)
      return skills
    }
  }

  // Search common skill locations
  const prioritySearchDirs = [
    searchPath,
    join(searchPath, 'skills'),
    join(searchPath, 'skills/.curated'),
    join(searchPath, 'skills/.experimental'),
    join(searchPath, 'skills/.system'),
    join(searchPath, '.agents/skills'),
    join(searchPath, '.claude/skills'),
  ]

  for (const dir of prioritySearchDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = join(dir, entry.name)
          if (await hasSkillMd(skillDir)) {
            const skill = await parseSkillMd(join(skillDir, 'SKILL.md'))
            if (skill && !seenNames.has(skill.name)) {
              skills.push(skill)
              seenNames.add(skill.name)
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Fallback: recursive search
  if (skills.length === 0) {
    const allSkillDirs = await findSkillDirs(searchPath)
    for (const skillDir of allSkillDirs) {
      const skill = await parseSkillMd(join(skillDir, 'SKILL.md'))
      if (skill && !seenNames.has(skill.name)) {
        skills.push(skill)
        seenNames.add(skill.name)
      }
    }
  }

  return skills
}

// ---------------------------------------------------------------------------
// Installer helpers (from installer.ts)
// ---------------------------------------------------------------------------

function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  return sanitized.substring(0, 255) || 'unnamed-skill'
}

function isPathSafe(basePath: string, targetPath: string): boolean {
  const normalizedBase = normalize(resolve(basePath))
  const normalizedTarget = normalize(resolve(targetPath))
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase
}

// ---------------------------------------------------------------------------
// Lock file (from skill-lock.ts)
// ---------------------------------------------------------------------------

interface SkillLockEntry {
  source: string
  sourceType: string
  sourceUrl: string
  skillPath?: string
  skillFolderHash: string
  installedAt: string
  updatedAt: string
  /** Target ids written on the last install — what `remove` has to clean up. */
  targets?: string[]
}

interface SkillLockFile {
  version: number
  skills: Record<string, SkillLockEntry>
}

/**
 * Locks live next to the canonical directory, so a project keeps its own.
 *
 * A project lock is meant to be committed: it is what lets a teammate reproduce the
 * same skill set from the repo alone.
 */
function getSkillLockPath(ctx: ScopeContext): string {
  const root = ctx.scope === 'project' ? ctx.workspacePath! : ctx.homeDir ?? homedir()
  return join(root, AGENTS_DIR, LOCK_FILE)
}

async function readSkillLock(ctx: ScopeContext): Promise<SkillLockFile> {
  try {
    const content = await readFile(getSkillLockPath(ctx), 'utf-8')
    const parsed = JSON.parse(content) as SkillLockFile
    if (typeof parsed.version !== 'number' || !parsed.skills) return createEmptyLockFile()
    // Older locks are still readable — they just lack `targets`. Dropping them would
    // lose every skill's provenance, which is exactly what the UI wants to show.
    if (parsed.version < MIN_READABLE_LOCK_VERSION) return createEmptyLockFile()
    return { ...parsed, version: LOCK_VERSION }
  } catch {
    return createEmptyLockFile()
  }
}

async function writeSkillLock(ctx: ScopeContext, lock: SkillLockFile): Promise<void> {
  const lockPath = getSkillLockPath(ctx)
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf-8')
}

function createEmptyLockFile(): SkillLockFile {
  return { version: LOCK_VERSION, skills: {} }
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

async function addSkillToLock(
  ctx: ScopeContext,
  skillName: string,
  entry: Omit<SkillLockEntry, 'installedAt' | 'updatedAt'>,
): Promise<void> {
  const lock = await readSkillLock(ctx)
  const now = new Date().toISOString()
  const existing = lock.skills[skillName]
  lock.skills[skillName] = { ...entry, installedAt: existing?.installedAt ?? now, updatedAt: now }
  await writeSkillLock(ctx, lock)
}

async function removeSkillFromLock(ctx: ScopeContext, skillName: string): Promise<void> {
  const lock = await readSkillLock(ctx)
  delete lock.skills[skillName]
  await writeSkillLock(ctx, lock)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function displayPath(dir: string): string {
  return dir.startsWith(homedir()) ? dir.replace(homedir(), '~') : dir
}

/**
 * List installed skills for one scope.
 *
 * Scans every agent directory that exists, then folds the results by skill name: one
 * skill installed for four agents is one row listing four agents, not four rows. The
 * lock file supplies provenance (source, timestamps) that the directories don't carry.
 */
export async function listInstalledSkills(ctx: ScopeContext): Promise<InstalledSkill[]> {
  const targets = await resolveExistingTargets(ctx)
  const lock = await readSkillLock(ctx)
  const canonical = canonicalSkillsDir(ctx)

  const byName = new Map<string, InstalledSkill>()

  for (const target of targets) {
    const entries = await readdir(target.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      // Symlinked targets show up as links, not directories — follow them.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillDir = join(target.dir, entry.name)
      const skill = await parseSkillMd(join(skillDir, 'SKILL.md'))
      if (!skill) continue

      const existing = byName.get(skill.name)
      if (existing) {
        for (const agent of target.agents) {
          if (!existing.agents.includes(agent)) existing.agents.push(agent)
        }
        continue
      }

      const lockEntry = lock.skills[skill.name]
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        scope: ctx.scope,
        agents: [...target.agents],
        // Report the canonical location, not whichever directory we happened to hit first.
        path: displayPath(join(canonical, entry.name)),
        source: lockEntry?.source,
        sourceUrl: lockEntry?.sourceUrl,
        installedAt: lockEntry?.installedAt,
        updatedAt: lockEntry?.updatedAt,
      })
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Global skills, flagged when a project copy of the same name shadows them.
 *
 * Agents scan project directories before global ones, so a same-named project skill
 * silently wins. Surfacing that is the difference between "my edit did nothing" and
 * a one-line explanation.
 */
export async function listInstalledSkillsWithShadowing(
  scope: SkillScope,
  workspacePath?: string,
  homeDir?: string,
): Promise<InstalledSkill[]> {
  const skills = await listInstalledSkills({ scope, workspacePath, homeDir })
  if (scope !== 'global' || !workspacePath) return skills

  const projectSkills = await listInstalledSkills({ scope: 'project', workspacePath }).catch(() => [])
  const projectNames = new Set(projectSkills.map((s) => s.name))
  return skills.map((s) => (projectNames.has(s.name) ? { ...s, shadowed: true } : s))
}

/**
 * Discover skills in a source, honouring the `owner/repo@skill` filter form.
 */
async function discoverFromSource(parsed: ParsedSource, refresh = false): Promise<{ baseDir: string; skills: Skill[] }> {
  const baseDir = await resolveSourceDir(parsed, refresh)
  let skills = await discoverSkills(baseDir, parsed.subpath)
  if (parsed.skillFilter) {
    const filter = parsed.skillFilter.toLowerCase()
    skills = skills.filter((s) => s.name.toLowerCase() === filter)
  }
  return { baseDir, skills }
}

/**
 * List available skills from a source repo.
 */
export async function listAvailableSkills(source: string, refresh = false): Promise<SkillInfo[]> {
  const { skills } = await discoverFromSource(parseSource(source), refresh)
  return skills.map((s) => ({ name: s.name, description: s.description }))
}

/**
 * Read one skill's SKILL.md and bundled files so it can be previewed before installing.
 * Prefers the installed copy; falls back to the source repo when `source` is given.
 */
export async function getSkillDetail(
  skillName: string,
  source: string | undefined,
  ctx: ScopeContext,
): Promise<SkillDetail> {
  const installedDir = await findInstalledSkillDir(skillName, ctx)
  if (installedDir) {
    const skill = await parseSkillMd(join(installedDir, 'SKILL.md'))
    if (skill) {
      return buildDetail(skill, installedDir, 'installed', displayPath(installedDir))
    }
  }

  if (!source) {
    throw new Error(`Skill "${skillName}" is not installed and no source was provided.`)
  }

  const parsed = parseSource(source)
  const { baseDir, skills } = await discoverFromSource(parsed)
  const target = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase())
  if (!target) {
    throw new Error(`Skill "${skillName}" not found in source.`)
  }
  return buildDetail(target, target.path, 'source', relative(baseDir, target.path) || '.')
}

/** Split SKILL.md into renderable body + displayable frontmatter, and list bundled files. */
async function buildDetail(
  skill: Skill,
  dir: string,
  origin: 'installed' | 'source',
  displayPath: string,
): Promise<SkillDetail> {
  const raw = skill.rawContent ?? (await readFile(join(dir, 'SKILL.md'), 'utf-8').catch(() => ''))
  const parsed = matter(raw)
  const metadata: Record<string, string> = {}
  // Frontmatter often nests a `metadata:` block (author, version, …). Flatten one level
  // so each key gets its own badge instead of one badge holding a JSON blob.
  const collect = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (!prefix && (key === 'name' || key === 'description')) continue
      if (value === null || value === undefined || value === '') continue
      const label = prefix ? `${prefix}.${key}` : key
      if (Array.isArray(value)) {
        metadata[label] = value.map((v) => String(v)).join(', ')
      } else if (typeof value === 'object') {
        if (!prefix) collect(value as Record<string, unknown>, key)
      } else {
        metadata[label] = String(value)
      }
    }
  }
  collect(parsed.data as Record<string, unknown>, '')

  return {
    name: skill.name,
    description: skill.description,
    content: parsed.content.trim(),
    metadata,
    files: await listSkillFiles(dir),
    origin,
    path: displayPath,
  }
}

const MAX_LISTED_FILES = 200

/** Bundled files (scripts, references, assets) next to SKILL.md, relative + sorted. */
async function listSkillFiles(dir: string): Promise<SkillFile[]> {
  const files: SkillFile[] = []

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_LISTED_FILES) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return
      if (entry.name === '.git' || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else {
        const rel = relative(dir, full)
        if (rel === 'SKILL.md') continue
        const size = await stat(full).then((s) => s.size).catch(() => 0)
        files.push({ path: rel, size })
      }
    }
  }

  await walk(dir, 0)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Locate an installed skill's directory within one scope. */
async function findInstalledSkillDir(skillName: string, ctx: ScopeContext): Promise<string | null> {
  const candidates = [skillName, sanitizeName(skillName)]
  const targets = await resolveExistingTargets(ctx)

  for (const target of targets) {
    const base = target.dir
    for (const name of candidates) {
      const dir = join(base, name)
      if (!isPathSafe(base, dir)) continue
      try {
        await access(join(dir, 'SKILL.md'))
        return dir
      } catch {
        // try next candidate
      }
    }
    // Fall back to matching the frontmatter name, which can differ from the folder name.
    const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const dir = join(base, entry.name)
      const skill = await parseSkillMd(join(dir, 'SKILL.md'))
      if (skill && skill.name.toLowerCase() === skillName.toLowerCase()) return dir
    }
  }
  return null
}

/**
 * Install a skill into every agent directory the user actually has.
 *
 * The real files land in the canonical directory; other agents get a symlink to it
 * (or a copy, for the ones that don't follow links). That way `update` only has to
 * rewrite one directory for every agent to see the new version.
 */
export async function installSkill(
  source: string,
  skillName: string,
  ctx: ScopeContext,
): Promise<SkillInstallResult> {
  const parsed = parseSource(source)
  const { baseDir: skillsDir, skills } = await discoverFromSource(parsed)
  const target = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase())
  if (!target) {
    throw new Error(`Skill "${skillName}" not found in source.`)
  }

  const ownerRepo = getOwnerRepo(parsed)
  const written = await writeSkillToTargets(target, ctx)

  await addSkillToLock(ctx, target.name, {
    source: ownerRepo ?? source,
    sourceType: parsed.type,
    sourceUrl: parsed.url,
    skillPath: relative(skillsDir, target.path),
    skillFolderHash: target.rawContent ? computeContentHash(target.rawContent) : '',
    targets: written.map((t) => t.id),
  })

  const agentCount = new Set(written.flatMap((t) => t.agents)).size
  return {
    message: `Installed "${target.name}" for ${agentCount} agent${agentCount === 1 ? '' : 's'}`,
    targets: written.map(({ label, agents, path, method }) => ({ label, agents, path, method })),
  }
}

interface WrittenTarget extends SkillInstallTargetResult {
  id: string
}

/** Copy a discovered skill into the canonical dir, then link it everywhere else. */
async function writeSkillToTargets(skill: Skill, ctx: ScopeContext): Promise<WrittenTarget[]> {
  const safeName = sanitizeName(skill.name)
  const canonicalBase = canonicalSkillsDir(ctx)
  const canonicalDir = join(canonicalBase, safeName)

  if (!isPathSafe(canonicalBase, canonicalDir)) {
    throw new Error('Invalid skill name: potential path traversal detected')
  }

  await rm(canonicalDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(canonicalDir, { recursive: true })
  await copyDirectory(skill.path, canonicalDir)

  const targets = await resolveInstallTargets(ctx)
  const written: WrittenTarget[] = []

  for (const target of targets) {
    // One agent failing (permissions, read-only mount) must not lose the whole
    // install — the canonical copy is already on disk and usable.
    try {
      const method = await linkIntoTarget(canonicalDir, target, safeName)
      written.push({
        id: target.id,
        label: target.label,
        agents: target.agents,
        path: displayPath(join(target.dir, safeName)),
        method,
      })
    } catch {
      // skip this target
    }
  }

  return written
}

/**
 * Remove a skill from every directory in this scope.
 *
 * Sweeps all targets rather than stopping at the first hit: leaving a copy behind in
 * one agent's directory means that agent keeps advertising a skill the user removed.
 */
export async function removeSkill(skillName: string, ctx: ScopeContext): Promise<string> {
  const candidates = [skillName, sanitizeName(skillName)]
  const removedDirs: string[] = []

  for (const target of await resolveExistingTargets(ctx)) {
    const base = target.dir
    let hit = false

    for (const name of candidates) {
      const skillDir = join(base, name)
      if (!isPathSafe(base, skillDir)) continue
      try {
        await access(skillDir)
        await rm(skillDir, { recursive: true, force: true })
        removedDirs.push(skillDir)
        hit = true
        break
      } catch {
        // Try next candidate
      }
    }
    if (hit) continue

    // Also match by frontmatter name, which can differ from the folder name.
    const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillDir = join(base, entry.name)
      const skill = await parseSkillMd(join(skillDir, 'SKILL.md'))
      if (skill && skill.name.toLowerCase() === skillName.toLowerCase()) {
        await rm(skillDir, { recursive: true, force: true })
        removedDirs.push(skillDir)
        break
      }
    }
  }

  if (removedDirs.length === 0) {
    throw new Error(`Skill "${skillName}" not found.`)
  }

  await removeSkillFromLock(ctx, skillName).catch(() => {})
  return `Removed "${skillName}" from ${removedDirs.length} director${removedDirs.length === 1 ? 'y' : 'ies'}`
}

/**
 * Re-fetch a skill from the source recorded at install time.
 *
 * Refuses when the installed copy has local edits, unless forced — silently throwing
 * away a user's changes to a skill they tweaked is worse than making them confirm.
 */
export async function updateSkill(
  skillName: string,
  ctx: ScopeContext,
  force = false,
): Promise<SkillUpdateResult> {
  const lock = await readSkillLock(ctx)
  const entry = lock.skills[skillName]
  if (!entry) {
    throw new Error(
      `No install record for "${skillName}" — it was installed outside Operon, so there is no source to update from.`,
    )
  }

  if (!force) {
    const installedDir = await findInstalledSkillDir(skillName, ctx)
    if (installedDir && entry.skillFolderHash) {
      const current = await readFile(join(installedDir, 'SKILL.md'), 'utf-8').catch(() => null)
      if (current && computeContentHash(current) !== entry.skillFolderHash) {
        return {
          message: `"${skillName}" has local edits. Updating will overwrite them.`,
          needsForce: true,
        }
      }
    }
  }

  // refresh=true bypasses the repo cache — an update that reads a 6-hour-old clone
  // would report "already up to date" against stale content.
  const parsed = parseSource(entry.sourceType === 'local' ? entry.sourceUrl : entry.source || entry.sourceUrl)
  const { baseDir: skillsDir, skills } = await discoverFromSource(parsed, true)
  const target = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase())
  if (!target) {
    throw new Error(`"${skillName}" no longer exists in ${entry.source}.`)
  }

  const newHash = target.rawContent ? computeContentHash(target.rawContent) : ''
  if (newHash && newHash === entry.skillFolderHash && !force) {
    return { message: `"${skillName}" is already up to date.` }
  }

  const written = await writeSkillToTargets(target, ctx)
  await addSkillToLock(ctx, target.name, {
    source: entry.source,
    sourceType: parsed.type,
    sourceUrl: parsed.url,
    skillPath: relative(skillsDir, target.path),
    skillFolderHash: newHash,
    targets: written.map((t) => t.id),
  })

  return {
    message: `Updated "${target.name}" from ${entry.source}`,
    targets: written.map(({ label, agents, path, method }) => ({ label, agents, path, method })),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOwnerRepo(parsed: ParsedSource): string | null {
  if (parsed.type === 'local') return null
  // SSH URLs
  const sshMatch = parsed.url.match(/^git@[^:]+:(.+)$/)
  if (sshMatch) {
    const path = sshMatch[1]!.replace(/\.git$/, '')
    return path.includes('/') ? path : null
  }
  // HTTP(S) URLs
  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) return null
  try {
    const url = new URL(parsed.url)
    const path = url.pathname.slice(1).replace(/\.git$/, '')
    return path.includes('/') ? path : null
  } catch {
    return null
  }
}
