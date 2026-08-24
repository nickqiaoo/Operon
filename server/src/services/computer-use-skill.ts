/**
 * Operon's built-in Computer Use skill — the instructions that teach an agent to drive
 * local Mac apps through `computer.*` in the `node_repl` MCP.
 *
 * Install/remove mechanics live in `managed-skill.ts`; this module only declares which
 * skill we are talking about. Note the marker differs from the Browser one: markers are
 * per-skill so that each can be installed, refreshed and removed independently.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
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

export const COMPUTER_USE_SKILL: ManagedSkill = {
  dirName: 'operon-computer-use',
  marker: '<!-- OPERON_MANAGED_COMPUTER_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'computer', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    const req = createRequire(import.meta.url)
    return path.join(path.dirname(req.resolve('@operon/computer-use')), 'skill', 'SKILL.md')
  },
}

export const installComputerUseSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(COMPUTER_USE_SKILL, options)

export const uninstallComputerUseSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(COMPUTER_USE_SKILL, options)

export const syncComputerUseSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(COMPUTER_USE_SKILL, enabled, options)
