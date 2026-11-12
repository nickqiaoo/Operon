import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Harness } from 'operon-agents'
import type { AgentRef } from 'operon-agents-peers'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  chat: vi.fn(),
  record: vi.fn(),
  mcp: vi.fn(),
  plugins: vi.fn(),
  snapshot: vi.fn(() => ({ types: { coder: { instructions: 'Review carefully', modeId: 'workspace' } } })),
}))
vi.mock('../ai/state.js', () => ({
  getChatStorage: () => ({ findChatBySessionId: mocks.chat }),
  getSessionManager: () => ({ findBySessionId: mocks.record }),
}))
vi.mock('../mcp-config.js', () => ({ resolveMcpServersForSession: mocks.mcp }))
vi.mock('./plugins.js', () => ({ ensurePluginsLoaded: mocks.plugins }))
vi.mock('./peers-config.js', () => ({ peersConfigSnapshot: mocks.snapshot }))
vi.mock('./passive-observer.js', () => ({ observeSession: vi.fn() }))
vi.mock('./resolve-model.js', () => ({ modelRef: vi.fn(), resolveModel: vi.fn() }))
vi.mock('./session.js', () => ({ MODE_TO_PERMISSION: { workspace: 'workspace' } }))

import { configurePeersHost, createTeamsHostService, restoredSessionConfig } from './peers.js'

const recipient: AgentRef = {
  agentId: 'lead', sessionId: 'recipient-session', kind: 'session', type: 'lead',
  address: 'main', status: 'parked', updatedAt: 0,
}
const permission = { rules: [{ pattern: 'Bash', scope: 'project' as const, decision: 'deny' as const }] }
const workspaceSetup = vi.fn(async (_cwd: string) => ({
  servers: {}, permission, limits: { maxTurns: 4, maxStepsPerTurn: 9 },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.chat.mockReturnValue(undefined)
  mocks.record.mockReturnValue(undefined)
  mocks.plugins.mockResolvedValue(undefined)
  mocks.mcp.mockReturnValue({ operonrepl: { url: 'http://localhost/current-port/chat/42' } })
  mocks.getSession.mockImplementation((id: string) => id === 'creator-session' ? { workDir: '/creator' } : undefined)
  const harness = { getSession: mocks.getSession } as unknown as Harness
  configurePeersHost({
    harness: () => harness,
    workspaceSetup,
    defaultModelId: async () => 'model',
  })
})

function restoredConfig() {
  return restoredSessionConfig({ id: recipient.sessionId, workDir: '/recipient/project' })
}

describe('peer session restoration', () => {
  it('restores workspace policy and limits using the durable recipient directory', async () => {
    expect(await restoredConfig()).toEqual({
      permission, limits: { maxTurns: 4, maxStepsPerTurn: 9 }, mcp: { servers: {} },
    })
    expect(workspaceSetup).toHaveBeenCalledWith('/recipient/project')
  })

  it('rebuilds the recipient MCP scope after restart without a live record', async () => {
    mocks.chat.mockReturnValue({ id: 42, tp: 'chat', workspaceId: 7 })
    const config = await restoredConfig()
    expect(mocks.plugins).toHaveBeenCalledOnce()
    expect(mocks.mcp).toHaveBeenCalledWith('custom', { chatId: 42, cwd: '/recipient/project' })
    expect(config.appendSystemPrompt).toContain('OperonSpec')
    expect(config.mcp).toEqual({ servers: mocks.mcp.mock.results[0]?.value })
  })

  it('uses existing session options for conversation-specific MCP and instructions', async () => {
    const mcpServers = { scoped: { type: 'http', url: 'http://localhost/chat/42' } }
    mocks.chat.mockReturnValue({ id: 42 })
    mocks.record.mockReturnValue({ chatId: 42, params: { mcpServers, instructions: 'Lead instructions' } })
    const config = await restoredConfig()
    expect(config.mcp).toEqual({ servers: mcpServers })
    expect(config.appendSystemPrompt).toBe('Lead instructions')
    expect(mocks.mcp).not.toHaveBeenCalled()
  })

  it('does not inject app MCP into workflow sessions that opted out', async () => {
    mocks.chat.mockReturnValue({ id: 42, metadata: { workflowAgent: { runId: 'run' } } })
    expect((await restoredConfig()).mcp).toEqual({ servers: {} })
    expect(mocks.mcp).not.toHaveBeenCalled()
  })

  it('restores a legacy teammate protocol and type prompt', async () => {
    mocks.chat.mockReturnValue({ id: 43, metadata: { peer: { type: 'coder' } } })
    const config = await restoredConfig()
    expect(config.appendSystemPrompt).toContain('Hub tool')
    expect(config.appendSystemPrompt).toContain('Review carefully')
  })

  it('never names a permission mode, so the one the session last ran in survives', async () => {
    expect((await restoredConfig()).permission).not.toHaveProperty('mode')
  })

  it('applies the same workspace limits at teammate creation, in its lead directory', async () => {
    const opts = await createTeamsHostService().teammateOptions({
      creatorId: 'creator', creatorSessionId: 'creator-session', name: 'coder', team: 'team:creator:test', type: 'coder',
    })
    expect(opts).toMatchObject({
      workDir: '/creator',
      config: { limits: { maxTurns: 4, maxStepsPerTurn: 9 }, permission: { ...permission, mode: 'workspace' } },
    })
    expect(opts.config?.appendSystemPrompt).toContain('Review carefully')
  })
})
