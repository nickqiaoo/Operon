import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { resolveMcpServersForSession } from './mcp-config.js'

describe('resolveMcpServersForSession', () => {
  beforeEach(() => {
    browserUseEnabled = true
    computerUseEnabled = false
    chromeUseEnabled = false
  })

  it.each([
    'claude-code',
    'gemini',
    'kimi',
    'opencode',
    'cursor',
    'grok',
    'copilot',
    'custom',
  ])('injects the conversation-scoped node_repl into %s', (providerId) => {
    const servers = resolveMcpServersForSession(providerId, { chatId: 42 })
    expect(servers?.node_repl).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/node-repl-mcp?sessionId=42',
    })
  })

  it('does not override the node_repl owned by Codex', () => {
    const servers = resolveMcpServersForSession('codex', {
      chatId: 42,
      agentId: 1,
      projectId: 1,
    })
    expect(servers?.node_repl).toBeUndefined()
    expect(servers?.workspace_chat).toBeDefined()
    expect(servers?.taskboard).toBeDefined()
  })

  it('withholds node_repl only when every feature is switched off', () => {
    // This is the gate that actually matters: with no node_repl there is no `js` tool, so
    // the model cannot execute JS at all — it cannot bootstrap the browser client or reach
    // the preloaded `sky`, whatever it may have read elsewhere. The skill only decides
    // whether the model is told; this decides whether it is possible.
    browserUseEnabled = false
    computerUseEnabled = false
    chromeUseEnabled = false
    expect(resolveMcpServersForSession('claude-code', { chatId: 42 })?.node_repl).toBeUndefined()
  })

  it.each([
    ['Browser Use alone', true, false, false],
    ['Computer Use alone', false, true, false],
    ['Chrome alone', false, false, true],
    ['all three', true, true, true],
  ])('mounts node_repl with %s enabled', (_label, browser, computer, chrome) => {
    // node_repl is ONE server hosting computer.* and both browser backends, so any feature on
    // its own has to bring it up. Gating it on Browser Use alone would hand a
    // Chrome-only user a skill pointing at a tool that was never mounted.
    browserUseEnabled = browser
    computerUseEnabled = computer
    chromeUseEnabled = chrome
    expect(resolveMcpServersForSession('claude-code', { chatId: 42 })?.node_repl).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3100/api/node-repl-mcp?sessionId=42',
    })
  })

  it('keeps the rest of the MCP config intact when Browser Use is off', () => {
    browserUseEnabled = false
    computerUseEnabled = false
    chromeUseEnabled = false
    // The switch owns node_repl and nothing else — turning it off must not cost the
    // session its other first-party servers.
    const off = resolveMcpServersForSession('claude-code', { chatId: 42, agentId: 1, projectId: 1 })
    browserUseEnabled = true
    const on = resolveMcpServersForSession('claude-code', { chatId: 42, agentId: 1, projectId: 1 })
    delete on?.node_repl
    expect(off).toEqual(on)
  })

  it('keeps deterministic fake sessions free of external MCP tools', () => {
    expect(resolveMcpServersForSession('fake', { chatId: 42 })).toBeUndefined()
  })
})
