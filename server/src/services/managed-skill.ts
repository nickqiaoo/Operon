/**
 * Install/remove skills Operon manages on the user's behalf.
 *
 * Agents discover skills by scanning user-level directories themselves — Operon does
 * not "inject" them per session. `.agents/skills` covers Codex, Operon, Gemini,
 * OpenCode and Copilot; Grok and Claude Code also get copies in their native
 * `.grok/skills` and `.claude/skills` roots. That means a settings switch has to
 * write and delete real files: skipping the install is not enough, because a copy
 * left behind keeps advertising the workflow.
 *
 * Every managed skill carries its own marker comment. The marker is what makes us
 * the owner of that path:
 *   - a file with our marker is refreshed on startup, so app upgrades ship new text;
 *   - a file without it is user-authored and is never overwritten nor deleted.
 *
 * Markers are per-skill rather than one shared constant on purpose: changing the
 * marker of an already-installed skill would make the old on-disk copy look
 * user-authored, and we would silently stop managing it.
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SKILL_TARGETS } from './skill-targets.js'

export interface ManagedSkill {
  /** Directory name under the skill roots, and the skill's `name:` in frontmatter. */
  dirName: string
  /** Marker proving the on-disk file is ours to manage. Must appear in the source. */
  marker: string
  /** Resolves the packaged SKILL.md shipped inside the app. */
  sourceFile: () => string
}

export interface ManagedSkillOptions {
  homeDir?: string
  sourceFile?: string
}

export interface ManagedSkillInstallResult {
  installed: string[]
  unchanged: string[]
  skipped: string[]
}

export interface ManagedSkillUninstallResult {
  removed: string[]
  /** Present but user-authored — left alone, exactly as install refuses to overwrite it. */
  skipped: string[]
}

/**
 * Directory ids from `skill-targets.ts` that managed skills are written to.
 *
 * Deliberately narrower than what a user-initiated install fans out to. Managed skills
 * are written unconditionally — they follow an Operon feature toggle, not a detected
 * agent — so the list stays limited to the roots verified on-device. Adding an id here
 * means every user gets that directory created whether or not they use that agent.
 */
const MANAGED_TARGET_IDS = ['agents', 'grok', 'claude'] as const

/**
 * The user-level directories the bundled agent runtimes scan natively.
 *
 * Ordered by `MANAGED_TARGET_IDS`, not by table order: the install/uninstall results
 * are asserted positionally by tests, and the write order is observable to anyone
 * tailing the logs during an upgrade.
 */
function skillTargets(homeDir: string, dirName: string): string[] {
  const byId = new Map(SKILL_TARGETS.map((t) => [t.id, t]))
  const dirs = new Set(
    MANAGED_TARGET_IDS.map((id) => byId.get(id)?.globalDir(homeDir)).filter(
      (dir): dir is string => Boolean(dir),
    ),
  )
  return [...dirs].map((dir) => path.join(dir, dirName, 'SKILL.md'))
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function installManagedSkill(
  skill: ManagedSkill,
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> {
  const sourceFile = options.sourceFile ?? skill.sourceFile()
  const source = await readFile(sourceFile, 'utf8')
  if (!source.includes(skill.marker)) {
    throw new Error(`Skill source ${sourceFile} is missing ${skill.marker}`)
  }

  const homeDir = options.homeDir ?? os.homedir()
  const result: ManagedSkillInstallResult = { installed: [], unchanged: [], skipped: [] }

  for (const target of skillTargets(homeDir, skill.dirName)) {
    if (await exists(target)) {
      const current = await readFile(target, 'utf8')
      if (current === source) {
        result.unchanged.push(target)
        continue
      }
      if (!current.includes(skill.marker)) {
        result.skipped.push(target)
        continue
      }
    }

    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, source, 'utf8')
    result.installed.push(target)
  }

  return result
}

/**
 * Remove a managed skill again when its feature is switched off.
 *
 * The whole skill directory goes, not just SKILL.md — an empty folder still shows up
 * in some runtimes' listings.
 */
export async function uninstallManagedSkill(
  skill: ManagedSkill,
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> {
  const homeDir = options.homeDir ?? os.homedir()
  const result: ManagedSkillUninstallResult = { removed: [], skipped: [] }

  for (const target of skillTargets(homeDir, skill.dirName)) {
    if (!(await exists(target))) continue
    const current = await readFile(target, 'utf8')
    if (!current.includes(skill.marker)) {
      result.skipped.push(target)
      continue
    }
    await rm(path.dirname(target), { recursive: true, force: true })
    result.removed.push(target)
  }

  return result
}

/** Bring the on-disk skill in line with its setting. */
export async function syncManagedSkill(
  skill: ManagedSkill,
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> {
  if (enabled) await installManagedSkill(skill, options)
  else await uninstallManagedSkill(skill, options)
}
