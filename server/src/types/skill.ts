export type SkillScope = 'global' | 'project'

export interface SkillInfo {
  name: string
  description: string
}

export interface InstalledSkill {
  name: string
  description?: string
  scope: SkillScope
  /** Agents that can see this skill, derived from the directories it was written to. */
  agents: string[]
  /** Canonical install directory, `~`-abbreviated for display. */
  path: string
  /** Where it came from — `owner/repo` when known, else the raw source string. */
  source?: string
  sourceUrl?: string
  installedAt?: string
  updatedAt?: string
  /**
   * A project-scoped copy of the same name exists and wins during agent discovery.
   * Only ever set on global entries.
   */
  shadowed?: boolean
}

/** One bundled file inside a skill directory (scripts, references, assets). */
export interface SkillFile {
  /** Path relative to the skill directory. */
  path: string
  size: number
}

/** Everything needed to preview a skill before (or after) installing it. */
export interface SkillDetail {
  name: string
  description: string
  /** SKILL.md body with the YAML frontmatter stripped — ready to render as markdown. */
  content: string
  /** Frontmatter keys other than name/description, flattened to strings for display. */
  metadata: Record<string, string>
  files: SkillFile[]
  /** Where this preview was read from: the installed copy or a remote source repo. */
  origin: 'installed' | 'source'
  /** Absolute path (installed) or repo-relative path (source). */
  path: string
}

/** Per-target outcome of one install, so the UI can say where the skill landed. */
export interface SkillInstallTargetResult {
  label: string
  agents: string[]
  path: string
  method: 'canonical' | 'symlink' | 'copy'
}

export interface SkillInstallResult {
  message: string
  targets: SkillInstallTargetResult[]
}

export interface SkillScopeInput {
  scope?: SkillScope
  /** Workspace root — required when scope is `project`. */
  workspacePath?: string
}

export interface SkillInstallInput extends SkillScopeInput {
  source: string
  skillName: string
}

export interface SkillRemoveInput extends SkillScopeInput {
  skillName: string
}

export interface SkillUpdateInput extends SkillScopeInput {
  skillName: string
  /** Overwrite even when the installed copy has local edits. */
  force?: boolean
}

export interface SkillUpdateResult {
  message: string
  /** Set when the update was refused because the local copy has been edited. */
  needsForce?: boolean
  targets?: SkillInstallTargetResult[]
}
