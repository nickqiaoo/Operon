/**
 * Where skills go on disk, for every agent Operon can drive.
 *
 * Agents discover skills by scanning directories themselves — Operon does not inject
 * them per session (see `managed-skill.ts` for the consequences). So "installing" a
 * skill means writing it into every directory the user's agents actually read.
 *
 * One skill install writes:
 *   - the canonical copy, under `.agents/skills/<name>` — the single source of truth;
 *   - a link (or copy) of it in every other detected agent root.
 *
 * Targets are keyed by *directory*, not by agent, because several agents share one
 * root: `.agents/skills` alone serves Operon, Codex, Kimi, Cursor and friends. Each
 * entry therefore carries the list of agents it feeds, which is what the UI shows.
 *
 * Detection matters: writing `~/.cursor/skills/` on a machine with no Cursor just
 * litters the home directory. A target is only written when its `detect` root already
 * exists — except the canonical one, which is always created.
 */
import { access, cp, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type SkillScope = 'global' | 'project'

/** How a non-canonical target gets its copy of the skill. */
type LinkStrategy = 'canonical' | 'symlink' | 'copy'

export interface SkillTarget {
  /** Stable id for this directory. */
  id: string
  /** Shown in the UI when listing where a skill landed. */
  label: string
  /** Agents that read this directory. */
  agents: string[]
  /** Absolute global directory. */
  globalDir: (home: string) => string
  /** Workspace-relative project directory, or null when the agent is global-only. */
  projectDir: string | null
  strategy: LinkStrategy
  /**
   * Directory whose existence proves the agent is installed. Relative to home for
   * global scope, to the workspace for project scope. Ignored for the canonical target.
   */
  detectGlobal: (home: string) => string
  detectProject: string | null
}

/**
 * `.agents/skills` first — it is the canonical target, and the rest link back to it.
 *
 * Paths follow the agent-skills convention (the same table `npx skills` publishes);
 * the three Operon has actually verified on-device are `.agents`, `.claude` and
 * `.grok`, which is what `managed-skill.ts` shipped before this table existed.
 */
export const SKILL_TARGETS: SkillTarget[] = [
  {
    id: 'agents',
    label: 'Operon, Codex, Cursor, Gemini, Copilot, Kimi, OpenCode',
    agents: ['operon', 'codex', 'cursor', 'gemini', 'copilot', 'kimi', 'opencode'],
    globalDir: (home) => path.join(home, '.agents', 'skills'),
    projectDir: path.join('.agents', 'skills'),
    strategy: 'canonical',
    detectGlobal: (home) => path.join(home, '.agents'),
    detectProject: null, // canonical — always written
  },
  {
    id: 'claude',
    label: 'Claude Code',
    agents: ['claude'],
    globalDir: (home) => path.join(home, '.claude', 'skills'),
    projectDir: path.join('.claude', 'skills'),
    // Claude Code has a history of not following symlinked skill directories, so it
    // gets a real copy. Upstream `skills` carries the same exemption.
    strategy: 'copy',
    detectGlobal: (home) => path.join(home, '.claude'),
    detectProject: '.claude',
  },
  {
    id: 'grok',
    label: 'Grok',
    agents: ['grok'],
    globalDir: (home) => path.join(home, '.grok', 'skills'),
    projectDir: path.join('.grok', 'skills'),
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.grok'),
    detectProject: '.grok',
  },
  {
    id: 'codex',
    label: 'Codex',
    agents: ['codex'],
    globalDir: (home) => path.join(home, '.codex', 'skills'),
    projectDir: null, // Codex reads .agents/skills inside a project
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.codex'),
    detectProject: null,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    agents: ['cursor'],
    globalDir: (home) => path.join(home, '.cursor', 'skills'),
    projectDir: null,
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.cursor'),
    detectProject: null,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    agents: ['gemini'],
    globalDir: (home) => path.join(home, '.gemini', 'skills'),
    projectDir: null,
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.gemini'),
    detectProject: null,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    agents: ['copilot'],
    globalDir: (home) => path.join(home, '.copilot', 'skills'),
    projectDir: null,
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.copilot'),
    detectProject: null,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    agents: ['opencode'],
    globalDir: (home) => path.join(home, '.config', 'opencode', 'skills'),
    projectDir: null,
    strategy: 'symlink',
    detectGlobal: (home) => path.join(home, '.config', 'opencode'),
    detectProject: null,
  },
]

export const CANONICAL_TARGET = SKILL_TARGETS[0]!

export interface ResolvedTarget {
  id: string
  label: string
  agents: string[]
  /** Absolute skills directory for the requested scope. */
  dir: string
  strategy: LinkStrategy
}

export interface ScopeContext {
  scope: SkillScope
  /** Workspace root — required for project scope. */
  workspacePath?: string
  /** Overrides the home directory. Tests only; production always uses the real one. */
  homeDir?: string
}

async function exists(dir: string): Promise<boolean> {
  try {
    await access(dir)
    return true
  } catch {
    return false
  }
}

function scopeRoot(ctx: ScopeContext): string {
  if (ctx.scope === 'project') {
    if (!ctx.workspacePath) throw new Error('Project scope requires a workspace path')
    return ctx.workspacePath
  }
  return ctx.homeDir ?? os.homedir()
}

/** The one directory that holds the real files; everything else links back to it. */
export function canonicalSkillsDir(ctx: ScopeContext): string {
  const root = scopeRoot(ctx)
  return ctx.scope === 'project'
    ? path.join(root, CANONICAL_TARGET.projectDir!)
    : CANONICAL_TARGET.globalDir(root)
}

/** Resolve a target to its directory in this scope, or null when it has no such form. */
function targetDir(target: SkillTarget, ctx: ScopeContext): string | null {
  const root = scopeRoot(ctx)
  if (ctx.scope === 'project') {
    return target.projectDir ? path.join(root, target.projectDir) : null
  }
  return target.globalDir(root)
}

/**
 * Targets to write on install: the canonical one plus every detected agent.
 *
 * Deduplicated by directory — in project scope most agents collapse onto
 * `.agents/skills`, and writing it eight times would be pointless.
 */
export async function resolveInstallTargets(ctx: ScopeContext): Promise<ResolvedTarget[]> {
  const root = scopeRoot(ctx)
  const resolved: ResolvedTarget[] = []
  const seenDirs = new Map<string, ResolvedTarget>()

  for (const target of SKILL_TARGETS) {
    const dir = targetDir(target, ctx)
    if (!dir) continue

    // Merge agents when two entries resolve to the same directory.
    const already = seenDirs.get(dir)
    if (already) {
      for (const agent of target.agents) {
        if (!already.agents.includes(agent)) already.agents.push(agent)
      }
      continue
    }

    if (target.strategy !== 'canonical') {
      const detect =
        ctx.scope === 'project'
          ? target.detectProject && path.join(root, target.detectProject)
          : target.detectGlobal(root)
      // No detect path in this scope means the agent has no project-local form.
      if (!detect || !(await exists(detect))) continue
    }

    const entry: ResolvedTarget = {
      id: target.id,
      label: target.label,
      agents: [...target.agents],
      dir,
      strategy: target.strategy,
    }
    seenDirs.set(dir, entry)
    resolved.push(entry)
  }

  return resolved
}

/**
 * Every directory worth scanning when listing or removing.
 *
 * Unlike install, this ignores detection: a directory that exists must be listed even
 * if the agent was uninstalled since, otherwise stale skills become invisible and
 * un-removable.
 */
export async function resolveExistingTargets(ctx: ScopeContext): Promise<ResolvedTarget[]> {
  const all: ResolvedTarget[] = []
  const seenDirs = new Set<string>()

  for (const target of SKILL_TARGETS) {
    const dir = targetDir(target, ctx)
    if (!dir || seenDirs.has(dir)) continue
    if (!(await exists(dir))) continue
    seenDirs.add(dir)
    all.push({
      id: target.id,
      label: target.label,
      agents: [...target.agents],
      dir,
      strategy: target.strategy,
    })
  }

  return all
}

const EXCLUDE_FILES = new Set(['metadata.json'])
const EXCLUDE_DIRS = new Set(['.git'])

/** Recursive copy that drops VCS noise and `_`-prefixed private files. */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => {
        if (EXCLUDE_FILES.has(entry.name)) return false
        if (entry.name.startsWith('_')) return false
        if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) return false
        return true
      })
      .map(async (entry) => {
        const srcPath = path.join(src, entry.name)
        const destPath = path.join(dest, entry.name)
        if (entry.isDirectory()) {
          await copyDirectory(srcPath, destPath)
        } else {
          await cp(srcPath, destPath, { dereference: true, recursive: true })
        }
      }),
  )
}

/**
 * Point `targetDir/<name>` at the canonical copy.
 *
 * Symlinks keep one source of truth so `update` only has to rewrite the canonical
 * directory. When the platform refuses (Windows without developer mode, some network
 * filesystems) we fall back to copying rather than failing the whole install.
 */
export async function linkIntoTarget(
  canonicalDir: string,
  target: ResolvedTarget,
  skillDirName: string,
): Promise<'canonical' | 'symlink' | 'copy'> {
  const dest = path.join(target.dir, skillDirName)
  if (path.resolve(dest) === path.resolve(canonicalDir)) return 'canonical'

  await mkdir(target.dir, { recursive: true })
  await rm(dest, { recursive: true, force: true }).catch(() => {})

  if (target.strategy === 'symlink') {
    try {
      await symlink(canonicalDir, dest, 'dir')
      return 'symlink'
    } catch {
      // fall through to copy
    }
  }

  await copyDirectory(canonicalDir, dest)
  return 'copy'
}

/** True when `dir` is a symlink pointing at the canonical copy we manage. */
export async function isLinkTo(dir: string, canonicalDir: string): Promise<boolean> {
  try {
    const stats = await lstat(dir)
    if (!stats.isSymbolicLink()) return false
    const resolvedLink = path.resolve(await readlink(dir))
    return resolvedLink === path.resolve(canonicalDir)
  } catch {
    return false
  }
}
