import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

const testDataDir = vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'operonrepl-mcp-config-'))
  process.env.OPERON_DATA_DIR = dir
  return dir
})

afterAll(async () => rmSync(await testDataDir, { recursive: true, force: true }))

vi.mock('./vector/embeddings.js', () => ({ getEmbeddingConfig: () => undefined }))
vi.mock('./ai.js', () => ({
  getSessionManager: () => ({ listProviders: () => [] }),
}))
vi.mock('./adapter/bundled-cli-paths.js', () => ({ isAdapterAvailable: () => true }))

let browserUseEnabled = true
let computerUseEnabled = false
let chromeUseEnabled = false
vi.mock('./browser-use-config.js', () => ({
  getBrowserUseConfig: () => ({ enabled: browserUseEnabled }),
}))
vi.mock('./computer-use-config.js', () => ({
  getComputerUseConfig: () => ({ enabled: computerUseEnabled }),
}))
vi.mock('./chrome-use-config.js', () => ({
  getChromeUseConfig: () => ({ enabled: chromeUseEnabled }),
}))

type PluginMount = import('./operon-runtime/plugin-mcp.js').PluginMcpMount
let pluginMounts: PluginMount[] = []
vi.mock('./operon-runtime/plugin-mcp.js', () => ({ listPluginMcpMounts: () => pluginMounts }))

import { resolveMcpServersForSession, saveMcpServers } from './mcp-config.js'

describe('resolveMcpServersForSession', () => {
  beforeEach(() => {
    browserUseEnabled = true
    computerUseEnabled = false
    chromeUseEnabled = false
    pluginMounts = []
    saveMcpServers({})
  })

  it('mounts plugin MCP servers for other agents but not for Operon itself', () => {
    const base = { pluginId: 'linear', pluginName: 'Linear', transport: 'http' as const }
    pluginMounts = [
      { ...base, kind: 'gateway', reason: 'oauth', name: 'plugin_linear_linear', server: 'linear', runtimeName: 'plugin-linear:linear' },
      {
        ...base,
        kind: 'direct',
        name: 'plugin_linear_docs',
        server: 'docs',
        runtimeName: 'plugin-linear:docs',
        entry: { type: 'http', url: 'https://docs.test/mcp' },
      },
      { ...base, kind: 'skip', reason: 'http server has no url', name: 'plugin_linear_x', server: 'x', runtimeName: 'plugin-linear:x' },
    ]
    const claude = resolveMcpServersForSession('claude-code', { chatId: 42 })
    expect(claude?.plugin_linear_linear).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/mcp-gateway/plugin_linear_linear',
    })
    expect(claude?.plugin_linear_docs).toEqual({ type: 'http', url: 'https://docs.test/mcp' })
    expect(claude?.plugin_linear_x).toBeUndefined()
    expect(resolveMcpServersForSession('custom', { chatId: 42 })?.plugin_linear_linear).toBeUndefined()
  })

  it.each([
    'claude-code',
    'codex',
    'kimi',
    'cursor',
    'grok',
    'copilot',
    'antigravity',
    'custom',
  ])('injects the conversation-scoped operonrepl into %s', (providerId) => {
    const servers = resolveMcpServersForSession(providerId, { chatId: 42 })
    expect(servers?.operonrepl).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/operonrepl-mcp?sessionId=42',
    })
  })

  it('leaves the conversation off shared OpenCode registrations and on everyone else\'s', () => {
    const opencode = resolveMcpServersForSession('opencode', { chatId: 42, cwd: '/w' })
    expect(opencode?.operonrepl).toEqual({ type: 'http', url: 'http://127.0.0.1:3100/api/operonrepl-mcp' })
    expect(opencode?.external_agent?.type === 'http' && opencode.external_agent.url).toBe(
      'http://127.0.0.1:3100/api/external-agent-mcp?caller=opencode&chatId=',
    )
    expect(opencode?.workflow?.type === 'http' && opencode.workflow.url).toBe(
      'http://127.0.0.1:3100/api/workflow-mcp?sessionId=&cwd=%2Fw',
    )
    const claude = resolveMcpServersForSession('claude-code', { chatId: 42, cwd: '/w' })
    expect(claude?.external_agent?.type === 'http' && claude.external_agent.url).toBe(
      'http://127.0.0.1:3100/api/external-agent-mcp?caller=claude-code&chatId=42',
    )
    expect(claude?.workflow?.type === 'http' && claude.workflow.url).toBe(
      'http://127.0.0.1:3100/api/workflow-mcp?sessionId=42&cwd=%2Fw',
    )
  })

  it('mounts operonrepl for Codex without adding a conflicting node_repl entry', () => {
    const servers = resolveMcpServersForSession('codex', {
      chatId: 42,
      agentId: 1,
      projectId: 1,
    })
    expect(servers?.operonrepl).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/operonrepl-mcp?sessionId=42',
    })
    expect(servers?.node_repl).toBeUndefined()
    expect(servers?.workspace_chat).toBeDefined()
    expect(servers?.taskboard).toBeDefined()
  })

  it('withholds operonrepl only when every feature is switched off', () => {
    // This is the gate that actually matters: with no operonrepl there is no `js` tool, so
    // the model cannot execute JS at all — it cannot bootstrap the browser client or reach
    // the preloaded `sky`, whatever it may have read elsewhere. The skill only decides
    // whether the model is told; this decides whether it is possible.
    browserUseEnabled = false
    computerUseEnabled = false
    chromeUseEnabled = false
    expect(resolveMcpServersForSession('claude-code', { chatId: 42 })?.operonrepl).toBeUndefined()
  })

  it.each([
    ['Browser Use alone', true, false, false],
    ['Computer Use alone', false, true, false],
    ['Chrome alone', false, false, true],
    ['all three', true, true, true],
  ])('mounts operonrepl with %s enabled', (_label, browser, computer, chrome) => {
    // operonrepl is ONE server hosting computer.* and both browser backends, so any feature on
    // its own has to bring it up. Gating it on Browser Use alone would hand a
    // Chrome-only user a skill pointing at a tool that was never mounted.
    browserUseEnabled = browser
    computerUseEnabled = computer
    chromeUseEnabled = chrome
    expect(resolveMcpServersForSession('claude-code', { chatId: 42 })?.operonrepl).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/operonrepl-mcp?sessionId=42',
    })
  })

  it('keeps the rest of the MCP config intact when Browser Use is off', () => {
    browserUseEnabled = false
    computerUseEnabled = false
    chromeUseEnabled = false
    // The switch owns operonrepl and nothing else — turning it off must not cost the
    // session its other first-party servers.
    const off = resolveMcpServersForSession('claude-code', { chatId: 42, agentId: 1, projectId: 1 })
    browserUseEnabled = true
    const on = resolveMcpServersForSession('claude-code', { chatId: 42, agentId: 1, projectId: 1 })
    delete on?.operonrepl
    expect(off).toEqual(on)
  })

  it('keeps deterministic fake sessions free of external MCP tools', () => {
    expect(resolveMcpServersForSession('fake', { chatId: 42 })).toBeUndefined()
  })

  it.each(['codex', 'claude-code', 'opencode'])('preserves external Node REPL configuration on %s', (providerId) => {
    const external = { command: '/external/node_repl', args: ['--stdio'] }
    saveMcpServers({ node_repl: external })
    const servers = resolveMcpServersForSession(providerId, { chatId: 42 })
    expect(servers?.node_repl).toEqual(external)
    expect(servers?.operonrepl).toMatchObject({ type: 'http' })
  })

  it.each(['node_repl', 'operon_node_repl'])('removes the legacy Operon mount %s without retaining an alias', (name) => {
    saveMcpServers({ [name]: { type: 'http', url: 'http://127.0.0.1:3100/api/node-repl-mcp?sessionId=old' } })
    const servers = resolveMcpServersForSession('codex', { chatId: 42 })
    expect(servers).not.toHaveProperty(name)
    expect(servers?.operonrepl).toMatchObject({ type: 'http' })
    browserUseEnabled = false
    expect(resolveMcpServersForSession('codex', { chatId: 42 })?.operonrepl).toBeUndefined()
  })

  it('preserves a remote external REPL even when its URL uses the old path', () => {
    const external = { type: 'http' as const, url: 'https://external.test/api/node-repl-mcp' }
    saveMcpServers({ node_repl: external })
    expect(resolveMcpServersForSession('codex', { chatId: 42 })?.node_repl).toEqual(external)
  })
})
