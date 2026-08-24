/**
 * Operon site-adapters index skill — discovery layer over
 * `@operon/site-adapters` (node_repl + Chrome / public APIs).
 *
 * Installed when Chrome Use is enabled.
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

export const SITE_ADAPTERS_SKILL: ManagedSkill = {
  dirName: 'operon-site-adapters',
  marker: '<!-- OPERON_MANAGED_SITE_ADAPTERS_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'site-adapters', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    const req = createRequire(import.meta.url)
    return path.join(
      path.dirname(req.resolve('@operon/site-adapters')),
      'skill',
      'site-adapters',
      'SKILL.md',
    )
  },
}

export const installSiteAdaptersSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(SITE_ADAPTERS_SKILL, options)

export const uninstallSiteAdaptersSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(SITE_ADAPTERS_SKILL, options)

export const syncSiteAdaptersSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(SITE_ADAPTERS_SKILL, enabled, options)
