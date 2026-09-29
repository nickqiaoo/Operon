import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import matter from 'gray-matter'
import { syncManagedSkills, type ManagedSkillSpec } from '../skill.js'
import type { OperonPluginManager } from './codex-plugin-apps.js'

/**
 * Lands every enabled plugin's skills into the shared skill directories (`~/.agents/skills` and
 * the per-agent links), so Claude Code, Codex, OpenCode… see them as well as Operon. The skill
 * layer does the writing; this module only works out what the desired set is.
 *
 * Called after anything that can change that set (startup, install, remove, enable, reload).
 * It always passes the full set, never a delta, so any call also repairs drift.
 */

/** Skill names each plugin ships that could not land because the name was already taken. */
const conflictsByPlugin = new Map<string, string[]>()
let chain: Promise<void> = Promise.resolve()

export function pluginSkillConflicts(pluginId: string): string[] {
  return conflictsByPlugin.get(pluginId.toLowerCase()) ?? []
}

export function syncPluginSkills(manager: OperonPluginManager, homeDir?: string): Promise<void> {
  // Serialized: two overlapping syncs would both see "not landed yet" and race on the same links.
  const run = chain.then(() => runSync(manager, homeDir))
  chain = run.catch(() => {})
  return run
}

async function runSync(manager: OperonPluginManager, homeDir?: string): Promise<void> {
  const displayNames = new Map(manager.summaries().map((s) => [s.id, s.displayName]))
  const roots = [...manager.pluginSkillRoots()].sort((a, b) => (a.plugin?.id ?? '').localeCompare(b.plugin?.id ?? ''))
  const desired: ManagedSkillSpec[] = []
  for (const root of roots) {
    const plugin = root.plugin!.id
    for (const dir of await skillDirs(root.path)) {
      desired.push({
        name: await skillName(dir),
        dir,
        managedBy: { plugin, displayName: displayNames.get(plugin) ?? plugin },
      })
    }
  }
  const conflicts = await syncManagedSkills({ scope: 'global', ...(homeDir ? { homeDir } : {}) }, desired)
  conflictsByPlugin.clear()
  for (const { name, plugin } of conflicts) {
    conflictsByPlugin.set(plugin, [...(conflictsByPlugin.get(plugin) ?? []), name])
  }
  if (conflicts.length > 0) {
    console.warn(`[plugins] skills not synced (name taken): ${conflicts.map((c) => `${c.plugin}/${c.name}`).join(', ')}`)
  }
}

/** A manifest skill root is either one skill (holds SKILL.md) or a container of skill dirs. */
async function skillDirs(root: string): Promise<string[]> {
  if (await isFile(join(root, 'SKILL.md'))) return [root]
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const dir = join(root, entry.name)
    if ((entry.isDirectory() || entry.isSymbolicLink()) && (await isFile(join(dir, 'SKILL.md')))) out.push(dir)
  }
  return out.sort()
}

async function skillName(dir: string): Promise<string> {
  try {
    const { data } = matter(await readFile(join(dir, 'SKILL.md'), 'utf-8'))
    if (typeof data.name === 'string' && data.name.trim().length > 0) return data.name.trim()
  } catch {
    // unreadable frontmatter — fall back to the directory name
  }
  return basename(dir)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}
