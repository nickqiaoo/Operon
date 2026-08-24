/**
 * Operon's built-in Workflow authoring skill.
 *
 * The Workflow MCP is always available, so this skill is installed unconditionally
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
const REPO_SKILL_PATH = path.join('packages', 'workflow', 'skill', 'SKILL.md')

/**
 * Find the repo copy in a dev run, by walking up from the running file.
 *
 * NOT `new URL('../../../packages/…', import.meta.url)`, which is what this used
 * to be and which failed twice over:
 *
 *  1. Vite recognises `new URL(<literal>, import.meta.url)` as an ASSET
 *     REFERENCE and inlines the target at build time — the bundle ended up with
 *     `fileURLToPath(new URL("data:text/markdown;base64,…"))`, which throws
 *     "The URL must be of scheme file". The sync has been failing on every
 *     startup since, silently (the caller logs a warning and moves on), which is
 *     why an on-disk skill from July was still being served to every agent.
 *  2. Even without the inlining the path was wrong: it is relative to this file
 *     in `server/src/services/`, but the code runs bundled from `dist-electron/`,
 *     three levels up from which is not the repo root.
 *
 * Walking up for a known file is immune to both: it does not care where the
 * bundle sits, and there is no literal for the bundler to treat as an asset.
 */
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

export const WORKFLOW_SKILL: ManagedSkill = {
  dirName: 'operon-workflow',
  marker: '<!-- OPERON_MANAGED_WORKFLOW_SKILL -->',
  sourceFile: () => {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const packaged = resourcesPath
      ? path.join(resourcesPath, 'operon-runtime', 'skills', 'workflow', 'SKILL.md')
      : ''
    if (packaged && existsSync(packaged)) return packaged
    return repoSkillFile()
  },
}

export const installWorkflowSkill = (
  options: ManagedSkillOptions = {},
): Promise<ManagedSkillInstallResult> => installManagedSkill(WORKFLOW_SKILL, options)

export const uninstallWorkflowSkill = (
  options: Pick<ManagedSkillOptions, 'homeDir'> = {},
): Promise<ManagedSkillUninstallResult> => uninstallManagedSkill(WORKFLOW_SKILL, options)

export const syncWorkflowSkill = (
  enabled: boolean,
  options: ManagedSkillOptions = {},
): Promise<void> => syncManagedSkill(WORKFLOW_SKILL, enabled, options)
