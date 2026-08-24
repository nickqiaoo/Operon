import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSiteAdaptersSkill, uninstallSiteAdaptersSkill } from './site-adapters-skill.js'
import { installChromeUseSkill } from './chrome-use-skill.js'

const tempDirs: string[] = []
const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string }
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

afterEach(async () => {
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor)
  } else {
    delete processWithResourcesPath.resourcesPath
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-site-adapters-skill-'))
  tempDirs.push(dir)
  return dir
}

const readSkill = (homeDir: string) =>
  readFile(path.join(homeDir, '.agents/skills/operon-site-adapters/SKILL.md'), 'utf8')

describe('installSiteAdaptersSkill', () => {
  it('installs for universal agents, Grok, and Claude Code', async () => {
    const homeDir = await tempHome()
    const result = await installSiteAdaptersSkill({ homeDir })

    expect(result.installed).toEqual([
      path.join(homeDir, '.agents/skills/operon-site-adapters/SKILL.md'),
      path.join(homeDir, '.grok/skills/operon-site-adapters/SKILL.md'),
      path.join(homeDir, '.claude/skills/operon-site-adapters/SKILL.md'),
    ])
    await expect(readSkill(homeDir)).resolves.toContain('name: operon-site-adapters')
    await expect(readSkill(homeDir)).resolves.toContain('OPERON_SITE_ADAPTERS_PATH')
    await expect(readSkill(homeDir)).resolves.toContain('siteAdapters.list()')
    await expect(readSkill(homeDir)).resolves.toContain('bilibili')
  })

  it('uses operon branding, not opencli CLI commands', async () => {
    const homeDir = await tempHome()
    await installSiteAdaptersSkill({ homeDir })
    const body = await readSkill(homeDir)

    expect(body).toContain('Operon')
    expect(body).not.toContain('opencli bilibili')
    expect(body).not.toContain('xui')
  })

  it('installs from the packaged runtime without resolving the workspace package', async () => {
    const homeDir = await tempHome()
    const resourcesPath = await tempHome()
    const packagedSkill = path.join(
      resourcesPath,
      'operon-runtime',
      'skills',
      'site-adapters',
      'SKILL.md',
    )
    await mkdir(path.dirname(packagedSkill), { recursive: true })
    await writeFile(
      packagedSkill,
      [
        '---',
        'name: operon-site-adapters',
        '---',
        '<!-- OPERON_MANAGED_SITE_ADAPTERS_SKILL -->',
        'Packaged source.',
      ].join('\n'),
      'utf8',
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    })

    await installSiteAdaptersSkill({ homeDir })

    await expect(readSkill(homeDir)).resolves.toContain('Packaged source.')
  })
})

describe('uninstallSiteAdaptersSkill', () => {
  it('removes the skill so agents stop discovering it', async () => {
    const homeDir = await tempHome()
    const installed = await installSiteAdaptersSkill({ homeDir })

    const result = await uninstallSiteAdaptersSkill({ homeDir })

    expect(result.removed).toEqual(installed.installed)
    for (const file of installed.installed) {
      await expect(access(path.dirname(file))).rejects.toThrow()
    }
  })
})

describe('site-adapters skill is independent of the chrome skill directory', () => {
  it('uninstalling site-adapters leaves operon-chrome installed', async () => {
    const homeDir = await tempHome()
    await installChromeUseSkill({ homeDir })
    await installSiteAdaptersSkill({ homeDir })

    await uninstallSiteAdaptersSkill({ homeDir })

    await expect(
      access(path.join(homeDir, '.agents/skills/operon-chrome/SKILL.md')),
    ).resolves.toBeUndefined()
    await expect(
      access(path.join(homeDir, '.agents/skills/operon-site-adapters/SKILL.md')),
    ).rejects.toThrow()
  })
})
