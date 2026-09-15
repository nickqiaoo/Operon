/**
 * Operon's built-in ExternalAgent usage skill.
 *
 * The ExternalAgent MCP is always available, so this skill is installed unconditionally
 * before provider sessions are created. Copy/ownership mechanics live in
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
const REPO_SKILL_PATH = path.join('packages', 'external-agent', 'skill', 'SKILL.md')

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

export const EXTERNAL_AGENT_SKILL: ManagedSkill = {
  dirName: 'operon-external-agent',
  marker: '<!-- OPERON_MANAGED_EXTERNAL_AGENT_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'external-agent', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    return repoSkillFile()
  },
}

export const installExternalAgentSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(EXTERNAL_AGENT_SKILL, options)

export const uninstallExternalAgentSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(EXTERNAL_AGENT_SKILL, options)

export const syncExternalAgentSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(EXTERNAL_AGENT_SKILL, enabled, options)
