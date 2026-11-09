import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTomlConfigStore } from '../../packages/computer-use/configStore.js'
import { syncManagedSkill } from '../src/services/managed-skill.js'
import { getOperonHome } from '../../shared/operon-home.js'

describe('app home isolation', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(path.join(os.tmpdir(), 'operon-profiles-'))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps production paths as the default', () => {
    vi.stubEnv('OPERON_HOME', undefined)
    expect(getOperonHome()).toBe(path.join(os.homedir(), '.operon'))
  })

  it('does not publish or remove the installed app skills from Dev', async () => {
    vi.stubEnv('OPERON_DEV', '1')
    const skill = {
      dirName: 'operon-profile-test',
      marker: '<!-- profile test -->',
      sourceFile: () => { throw new Error('Dev must not read global skill sources') },
    }
    const homeLookup = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('Dev must not inspect global CLI skill directories')
    })
    try {
      await expect(syncManagedSkill(skill, true)).resolves.toBeUndefined()
      await expect(syncManagedSkill(skill, false)).resolves.toBeUndefined()
    } finally {
      homeLookup.mockRestore()
    }
  })

  it('separates API tokens, SaaS identity and remembered browser approvals', async () => {
    const openProfile = async (name: string) => {
      vi.stubEnv('OPERON_HOME', path.join(root, name))
      vi.stubEnv('OPERON_API_TOKEN', undefined)
      vi.resetModules()
      const api = await import('../src/services/api-token.js')
      // Bypass the suite-wide offline SaaS mock; both homes are temporary.
      const saas = await vi.importActual<typeof import('../src/gateway/saas/config.js')>('../src/gateway/saas/config.js')
      return { api, saas, store: createTomlConfigStore() }
    }

    const prod = await openProfile('production')
    prod.api.publishApiToken()
    const prodToken = prod.api.getApiToken()
    prod.saas.setSaasConfig({ nodeId: 'production', nodeToken: 'production-token' })
    await prod.store.writeToml('browser/config.toml', { full_cdp_access_enabled: true })

    const dev = await openProfile('dev')
    expect(dev.saas.getSaasConfig()).toEqual({})
    expect(await dev.store.readToml('browser/config.toml')).toEqual({})
    dev.api.publishApiToken()
    expect(dev.api.getApiToken()).not.toBe(prodToken)
    dev.saas.setSaasConfig({ nodeId: 'dev', nodeToken: 'dev-token' })
    dev.saas.clearSaasConfig()
    await dev.store.writeToml('browser/config.toml', { full_cdp_access_enabled: false })

    expect(prod.saas.getSaasConfig().nodeId).toBe('production')
    expect(await prod.store.readToml('browser/config.toml')).toEqual({ full_cdp_access_enabled: true })
    expect(await readFile(path.join(root, 'production/run/api-token'), 'utf8')).toBe(prodToken)
    expect(await readFile(path.join(root, 'dev/run/api-token'), 'utf8')).toBe(dev.api.getApiToken())

    const { ASSISTANT_DIR } = await import('../src/services/assistant/paths.js')
    const { OPERON_DATA_DIR } = await import('../src/services/operon-runtime/paths.js')
    expect(ASSISTANT_DIR).toBe(path.join(root, 'dev/assistant'))
    expect(OPERON_DATA_DIR).toBe(path.join(root, 'dev/data'))
  })
})
