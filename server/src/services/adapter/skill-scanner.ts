import { promises as fs } from 'fs'
import path from 'path'
import type { ProviderSkill } from './types.js'

/**
 * Scan a list of directories for SKILL.md files and return skill metadata.
 * Each directory is expected to contain subdirectories with SKILL.md files,
 * e.g. `<baseDir>/<skill-name>/SKILL.md`
 *
 * Skills are deduplicated by name (first found wins).
 */
export async function scanSkillDirs(dirs: string[]): Promise<ProviderSkill[]> {
  const seen = new Set<string>()
  const skills: ProviderSkill[] = []

  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (seen.has(entry.name)) continue

        const skillFile = path.join(dir, entry.name, 'SKILL.md')
        const meta = await parseSkillFrontmatter(skillFile)
        if (meta) {
          seen.add(meta.name)
          skills.push(meta)
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return skills
}

async function parseSkillFrontmatter(filePath: string): Promise<ProviderSkill | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return null

    const yaml = match[1]
    const name = extractYamlValue(yaml, 'name')
    if (!name) return null

    const description = extractYamlValue(yaml, 'description') ?? ''
    return { name, description }
  } catch {
    return null
  }
}

function extractYamlValue(yaml: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  const match = yaml.match(regex)
  if (!match) return null
  return match[1].trim().replace(/^["']|["']$/g, '')
}
