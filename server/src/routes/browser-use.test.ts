import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => new Map<string, Record<string, unknown>>())
const sessionFiles = vi.hoisted(() => [] as string[])
const removedSessionFiles = vi.hoisted(() => [] as string[])

vi.mock('node:fs', () => ({
  default: {
    promises: {
      readdir: async () => sessionFiles,
      rm: async (path: string) => { removedSessionFiles.push(path) },
    },
  },
}))

vi.mock('@operon/computer-use', () => ({
  createTomlConfigStore: () => ({
    readToml: async (path: string) => files.get(path) ?? {},
    writeToml: async (path: string, value: Record<string, unknown>) => { files.set(path, value) },
  }),
}))
vi.mock('@operon/agent-runtime', () => ({ createRuntimeLogger: () => ({ info: () => {}, error: () => {} }) }))
vi.mock('../services/browser-use-config.js', () => ({ getBrowserUseConfig: () => ({ enabled: true }), updateBrowserUseConfig: () => {} }))
vi.mock('../services/browser-use-skill.js', () => ({ syncBrowserUseSkill: async () => {} }))
vi.mock('./node-repl-mcp.js', () => ({ disposeAllNodeReplSessions: async () => {} }))

const { browserUseRoutes } = await import('./browser-use.js')

async function post(path: string, body: Record<string, unknown>) {
  return browserUseRoutes().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function get(path: string) {
  return (await browserUseRoutes().request(path)).json() as Promise<{ modes: Record<string, string> }>
}

describe('browser permission settings', () => {
  beforeEach(() => {
    files.clear()
    sessionFiles.length = 0
    removedSessionFiles.length = 0
    files.set('browser/config.toml', {
      full_cdp_access_enabled: true,
      origins: { allowed: ['https://existing.example'] },
      downloads: { denied: ['https://blocked.example'] },
    })
  })

  it('adds and changes an exact site rule without dropping other browser permissions', async () => {
    const allow = await post('/approvals/rule', {
      resource: 'downloads', origin: 'https://files.example/path', decision: 'allow',
    })
    expect(allow.status).toBe(200)
    expect(await allow.json()).toMatchObject({ origin: 'https://files.example' })

    const deny = await post('/approvals/rule', {
      resource: 'downloads', origin: 'https://files.example', decision: 'deny',
    })
    expect(deny.status).toBe(200)
    expect(files.get('browser/config.toml')).toEqual({
      full_cdp_access_enabled: true,
      origins: { allowed: ['https://existing.example'] },
      downloads: {
        allowed: [], denied: ['https://blocked.example', 'https://files.example'],
      },
    })

    expect((await post('/approvals/rule/revoke', { resource: 'downloads', origin: 'https://files.example' })).status).toBe(200)
    expect(files.get('browser/config.toml')).toMatchObject({
      downloads: { denied: ['https://blocked.example'] },
    })
  })

  it('changes prompting mode while preserving specific rules and rejects invalid input', async () => {
    // Opening sites defaults to allowed, so only asking is written down.
    expect((await get('/approvals')).modes).toMatchObject({ origins: 'never_ask', downloads: 'ask' })
    expect((await post('/approvals/mode', { resource: 'origins', mode: 'ask' })).status).toBe(200)
    expect(files.get('browser/config.toml')).toMatchObject({
      approval_mode: 'ask',
      origins: { allowed: ['https://existing.example'] },
    })
    expect((await get('/approvals')).modes.origins).toBe('ask')
    expect((await post('/approvals/mode', { resource: 'origins', mode: 'never_ask' })).status).toBe(200)
    expect(files.get('browser/config.toml')).not.toHaveProperty('approval_mode')
    expect((await post('/approvals/mode', { resource: 'downloads', mode: 'never_ask' })).status).toBe(200)
    expect(files.get('browser/config.toml')).toMatchObject({ download_approval_mode: 'never_ask' })
    expect((await post('/approvals/rule', { resource: 'origins', origin: 'file:///etc/passwd', decision: 'allow' })).status).toBe(400)
    expect((await post('/approvals/mode', { resource: 'unknown', mode: 'never_ask' })).status).toBe(400)
  })

  it('counts conversation files rather than individual decisions, including file transfers', async () => {
    sessionFiles.push('first.toml', 'second.toml', 'empty.toml')
    files.set('browser/sessions/first.toml', {
      origins: { allowed: ['https://one.example', 'https://two.example'] },
    })
    files.set('browser/sessions/second.toml', {
      uploads: { denied: ['https://blocked.example'] },
    })
    files.set('browser/sessions/empty.toml', {})

    const response = await browserUseRoutes().request('/approvals')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ rememberedFromConversations: 2 })

    const cleared = await post('/approvals/clear', {})
    expect(await cleared.json()).toMatchObject({ cleared: 2 })
    expect(removedSessionFiles).toHaveLength(2)
    expect(removedSessionFiles.every((path) => !path.endsWith('empty.toml'))).toBe(true)
  })
})
