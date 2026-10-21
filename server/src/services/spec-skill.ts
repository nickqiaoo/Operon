/**
 * Operon's built-in OperonSpec skill.
 *
 * The spec tools (`start_spec` / `answer_spec_questions`) are always available on the
 * taskboard MCP, so this skill is installed unconditionally before provider sessions
 * are created. Copy/ownership mechanics live in
 * `managed-skill.ts`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import {
  installManagedSkill,
  syncManagedSkill,
  uninstallManagedSkill,
  type ManagedSkill,
  type ManagedSkillInstallResult,
  type ManagedSkillOptions,
  type ManagedSkillUninstallResult,
} from './managed-skill.js'

/** Where the skill lives in the repo, relative to its root. */
const REPO_SKILL_PATH = path.join('packages', 'spec', 'skill', 'SKILL.md')

function repoSkillFile(): string {
  const anchors = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()]
  for (const anchor of anchors) {
    let dir = anchor
    // Stop at the filesystem root, where dirname() becomes a fixed point.
    for (let up = path.dirname(dir); dir !== up; dir = up, up = path.dirname(dir)) {
      const candidate = path.join(dir, REPO_SKILL_PATH)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`Could not locate ${REPO_SKILL_PATH} from ${anchors.join(' or ')}`)
}

export const SPEC_SKILL: ManagedSkill = {
  dirName: 'operon-spec',
  marker: '<!-- OPERON_MANAGED_SPEC_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'spec', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    return repoSkillFile()
  },
}

export const installSpecSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(SPEC_SKILL, options)

export const uninstallSpecSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(SPEC_SKILL, options)

export const syncSpecSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(SPEC_SKILL, enabled, options)
