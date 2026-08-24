/**
 * Operon's Chrome skill: teaches an agent to drive the user's *own* Chrome
 * through the `node_repl` MCP.
 *
 * It is a separate skill behind a separate switch from `operon-browser-use`,
 * because they are two backends carrying two different risks: the IAB browser is
 * our own sandbox, while Chrome carries the user's signed-in sessions. Merging
 * them into one skill would leave the model free to improvise which browser to
 * use, and that choice is precisely what the user expressed in Settings.
 *
 * See `managed-skill.ts` for how installing and removing works, and why the
 * switch has to delete the file.
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

export const CHROME_USE_SKILL: ManagedSkill = {
  dirName: 'operon-chrome',
  // One marker per skill. Changing it would make every already-installed copy
  // look user-authored, and it would then be left in place forever.
  marker: '<!-- OPERON_MANAGED_CHROME_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'browser', 'chrome', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    const req = createRequire(import.meta.url)
    return path.join(
      path.dirname(req.resolve('@operon/browser-use')),
      'skill',
      'chrome',
      'SKILL.md',
    )
  },
}

export const installChromeUseSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(CHROME_USE_SKILL, options)

export const uninstallChromeUseSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(CHROME_USE_SKILL, options)

export const syncChromeUseSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(CHROME_USE_SKILL, enabled, options)
