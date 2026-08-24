import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

interface SkillMeta {
  name: string
  description: string
  dirPath: string
}

interface CwdCache {
  skills: SkillMeta[]
  loadPromise?: Promise<void>
}

/**
 * SkillLoader scans .agents/skills/ directories for SKILL.md files,
 * parses YAML frontmatter (name, description), and provides
 * skill metadata + full body content on demand.
 *
 * Scans project-level first, then user-level. Skills are deduplicated by name (first wins).
 *
 * Uses per-cwd caching to avoid race conditions when multiple
 * workspaces/projects load skills concurrently.
 */
export class SkillLoader {
  private static instance: SkillLoader | null = null

  private cacheByDir = new Map<string, CwdCache>()

  static getInstance(): SkillLoader {
    if (!SkillLoader.instance) {
      SkillLoader.instance = new SkillLoader()
    }
    return SkillLoader.instance
  }

  /**
   * @deprecated Use loadForCwd(cwd) instead. Kept for backward compatibility.
   */
  setCwd(_cwd: string): void {
    // no-op — cwd is now passed per-call
  }

  /**
   * Scan .agents/skills/ directories for SKILL.md files and parse their frontmatter.
   * Supports both .agents/skills/SKILL.md and .agents/skills/<name>/SKILL.md
   *
   * Results are cached per cwd. Concurrent calls for the same cwd share one scan.
   */
  async loadForCwd(cwd: string): Promise<void> {
    const cached = this.cacheByDir.get(cwd)
    if (cached && !cached.loadPromise) return // already loaded

    if (cached?.loadPromise) {
      await cached.loadPromise // wait for in-flight scan
      return
    }

    const entry: CwdCache = { skills: [] }
    const promise = this.scan(cwd).then((skills) => {
      entry.skills = skills
      entry.loadPromise = undefined
    }).catch(() => {
      entry.loadPromise = undefined
    })
    entry.loadPromise = promise
    this.cacheByDir.set(cwd, entry)
    await promise
  }

  /**
   * @deprecated Use loadForCwd(cwd) instead.
   */
  async load(): Promise<void> {
    // Fallback: scan for process.cwd()
    await this.loadForCwd(process.cwd())
  }

  /**
   * Returns a formatted string of skill names + descriptions for system prompt injection.
   * Returns undefined if no skills are available.
   */
  getSkillDescriptions(cwd?: string): string | undefined {
    const skills = this.getSkillsForCwd(cwd)
    if (skills.length === 0) return undefined

    const lines = [
      '## Available Skills',
      '',
      'You can activate any skill below by calling the `activate_skill` tool with the skill name.',
      'Only activate a skill when the user\'s request matches the skill\'s description.',
      '',
    ]

    for (const skill of skills) {
      lines.push(`- **${skill.name}**: ${skill.description}`)
    }

    return lines.join('\n')
  }

  /**
   * Returns the full SKILL.md body (without frontmatter) for the given skill name.
   */
  async getSkillBody(name: string): Promise<string | null> {
    const skill = this.findSkill(name)
    if (!skill) return null

    const skillPath = path.join(skill.dirPath, 'SKILL.md')
    try {
      const content = await fs.readFile(skillPath, 'utf-8')
      return this.extractBody(content)
    } catch {
      return null
    }
  }

  /**
   * Returns all discovered skill metadata.
   */
  listSkills(cwd?: string): SkillMeta[] {
    return [...this.getSkillsForCwd(cwd)]
  }

  /**
   * Returns the directory tree of skill assets (files in the skill directory).
   */
  async getSkillAssets(name: string): Promise<string | null> {
    const skill = this.findSkill(name)
    if (!skill) return null

    try {
      const entries = await fs.readdir(skill.dirPath, { withFileTypes: true })
      const lines: string[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        lines.push(entry.isDirectory() ? `[dir] ${entry.name}` : entry.name)
      }
      return lines.length > 0 ? lines.join('\n') : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getSkillsForCwd(cwd?: string): SkillMeta[] {
    if (cwd) {
      return this.cacheByDir.get(cwd)?.skills ?? []
    }
    // Fallback: return skills from any loaded cwd (for backward compat with activate_skill tool)
    for (const entry of this.cacheByDir.values()) {
      if (entry.skills.length > 0) return entry.skills
    }
    return []
  }

  private findSkill(name: string): SkillMeta | undefined {
    for (const entry of this.cacheByDir.values()) {
      const found = entry.skills.find(s => s.name === name)
      if (found) return found
    }
    return undefined
  }

  private async scan(cwd: string): Promise<SkillMeta[]> {
    const dirs = [
      path.join(cwd, '.agents', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ]
    const seen = new Set<string>()
    const results: SkillMeta[] = []

    for (const skillsDir of dirs) {
      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true })

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue

          if (entry.isDirectory()) {
            const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
            const meta = await this.parseSkillFile(skillPath, path.join(skillsDir, entry.name))
            if (meta && !seen.has(meta.name)) {
              seen.add(meta.name)
              results.push(meta)
            }
          } else if (entry.name === 'SKILL.md') {
            const meta = await this.parseSkillFile(path.join(skillsDir, entry.name), skillsDir)
            if (meta && !seen.has(meta.name)) {
              seen.add(meta.name)
              results.push(meta)
            }
          }
        }
      } catch {
        // directory doesn't exist — skip
      }
    }

    return results
  }

  private async parseSkillFile(filePath: string, dirPath: string): Promise<SkillMeta | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return this.parseFrontmatter(content, dirPath)
    } catch {
      return null
    }
  }

  private parseFrontmatter(content: string, dirPath: string): SkillMeta | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return null

    const yaml = match[1]
    const name = this.extractYamlValue(yaml, 'name')
    const description = this.extractYamlValue(yaml, 'description') ?? ''

    if (!name) return null

    return { name, description, dirPath }
  }

  private extractYamlValue(yaml: string, key: string): string | null {
    // Simple single-line YAML value extraction (handles quoted and unquoted)
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm')
    const match = yaml.match(regex)
    if (!match) return null
    return match[1].trim().replace(/^["']|["']$/g, '')
  }

  private extractBody(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n?/)
    if (!match) return content
    return content.slice(match[0].length).trim()
  }
}
