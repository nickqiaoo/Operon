/**
 * Operon's built-in Browser skill — the instructions that teach an agent to drive the
 * in-app browser through the `node_repl` MCP.
 *
 * Install/remove mechanics (and why a switch has to delete files) live in
 * `managed-skill.ts`; this module only declares which skill we are talking about.
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

export const BROWSER_USE_SKILL: ManagedSkill = {
  dirName: 'operon-browser-use',
  marker: '<!-- OPERON_MANAGED_BROWSER_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'browser', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    const req = createRequire(import.meta.url)
    return path.join(path.dirname(req.resolve('@operon/browser-use')), 'skill', 'SKILL.md')
  },
}

export type BrowserUseSkillInstallOptions = ManagedSkillOptions
export type BrowserUseSkillInstallResult = ManagedSkillInstallResult
export type BrowserUseSkillUninstallResult = ManagedSkillUninstallResult

export const installBrowserUseSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(BROWSER_USE_SKILL, options)

export const uninstallBrowserUseSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(BROWSER_USE_SKILL, options)

export const syncBrowserUseSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(BROWSER_USE_SKILL, enabled, options)
