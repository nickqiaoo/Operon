import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installWorkflowSkill, uninstallWorkflowSkill } from './workflow-skill.js'

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-workflow-skill-'))
  tempDirs.push(dir)
  return dir
}

const skillPath = (homeDir: string, root: '.agents' | '.grok' | '.claude') =>
  path.join(homeDir, root, 'skills', 'operon-workflow', 'SKILL.md')

describe('installWorkflowSkill', () => {
  it('installs the slash skill for universal agents, Grok, and Claude Code', async () => {
    const homeDir = await tempHome()

    const result = await installWorkflowSkill({ homeDir })

    expect(result.installed).toEqual([
      skillPath(homeDir, '.agents'),
      skillPath(homeDir, '.grok'),
      skillPath(homeDir, '.claude'),
    ])
    const source = await readFile(skillPath(homeDir, '.agents'), 'utf8')
    expect(source).toContain('name: operon-workflow')
    expect(source).toContain('`OperonWorkflow` MCP tool')
    expect(source).toContain("() => agent('Return exactly ping'")
    expect(source).toContain('agent(prompt, options?)')

    const second = await installWorkflowSkill({ homeDir })
    expect(second.unchanged).toEqual(result.installed)
  })

  it('does not overwrite a user-authored skill with the same name', async () => {
    const homeDir = await tempHome()
    const target = skillPath(homeDir, '.agents')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(
      target,
      '---\nname: operon-workflow\ndescription: User owned.\n---\nUser owned.\n',
      'utf8',
    )

    const result = await installWorkflowSkill({ homeDir })

    expect(result.skipped).toContain(target)
    await expect(readFile(target, 'utf8')).resolves.toContain('User owned.')
  })

  it('installs from the packaged runtime', async () => {
    const homeDir = await tempHome()
    const resourcesPath = await tempHome()
    const packagedSkill = path.join(
      resourcesPath,
      'operon-runtime',
      'skills',
      'workflow',
      'SKILL.md',
    )
    await mkdir(path.dirname(packagedSkill), { recursive: true })
    await writeFile(
      packagedSkill,
      [
        '---',
        'name: operon-workflow',
        'description: Packaged workflow skill.',
        '---',
        '<!-- OPERON_MANAGED_WORKFLOW_SKILL -->',
        'Packaged source.',
      ].join('\n'),
      'utf8',
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    })

    await installWorkflowSkill({ homeDir })

    await expect(readFile(skillPath(homeDir, '.agents'), 'utf8')).resolves.toContain(
      'Packaged source.',
    )
  })
})

describe('uninstallWorkflowSkill', () => {
  it('removes only managed copies', async () => {
    const homeDir = await tempHome()
    const installed = await installWorkflowSkill({ homeDir })

    const result = await uninstallWorkflowSkill({ homeDir })

    expect(result.removed).toEqual(installed.installed)
    for (const file of installed.installed) {
      await expect(access(path.dirname(file))).rejects.toThrow()
    }
  })
})
