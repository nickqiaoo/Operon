import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Harness, HarnessSession } from 'operon-agents'
import type { AgentRef, TeammateIdentity } from 'operon-agents-peers'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  chatMeta: vi.fn(),
  createChat: vi.fn(),
  record: vi.fn(),
  mcp: vi.fn(),
  plugins: vi.fn(),
  settings: vi.fn(),
}))
vi.mock('../ai/state.js', () => ({
  getChatStorage: () => ({ findChatBySessionId: mocks.chat, getChatMeta: mocks.chatMeta, createChat: mocks.createChat }),
  getSessionManager: () => ({ findBySessionId: mocks.record }),
}))
vi.mock('../mcp-config.js', () => ({ resolveMcpServersForSession: mocks.mcp }))
vi.mock('./plugins.js', () => ({ ensurePluginsLoaded: mocks.plugins }))

import { configurePeersHost, createTeammateChat, restoredSessionConfig } from './peers.js'

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
  mocks.chatMeta.mockReturnValue(undefined)
  mocks.record.mockReturnValue(undefined)
  mocks.plugins.mockResolvedValue(undefined)
  mocks.mcp.mockReturnValue({ operonrepl: { url: 'http://localhost/current-port/chat/42' } })
  mocks.settings.mockResolvedValue({ schema: { type: 'object' }, value: { types: { coder: { title: 'Coder' } } }, issues: [] })
  const harness = { extensions: { getSettings: mocks.settings } } as unknown as Harness
  configurePeersHost({ harness: () => harness, workspaceSetup })
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

  it('names no prompt for a teammate, so the one stored at its creation survives', async () => {
    mocks.chat.mockReturnValue({ id: 43, tp: 'teammate', workspaceId: 7, metadata: { peer: { type: 'coder' } } })
    mocks.record.mockReturnValue({ chatId: 43, params: { instructions: 'Lead instructions' } })
    expect(await restoredConfig()).not.toHaveProperty('appendSystemPrompt')
  })

  it('never names a permission mode, so the one the session last ran in survives', async () => {
    expect((await restoredConfig()).permission).not.toHaveProperty('mode')
  })

})

describe('teammate chat rows', () => {
  const member: TeammateIdentity = { agentId: 'team:lead-session:crew/c1', name: 'c1', team: 'team:lead-session:crew', type: 'coder', creatorSessionId: 'lead-session' }
  const session = { id: 'teammate-session', modelSetting: 'anthropic/claude-sonnet-5-5' } as unknown as HarnessSession

  it('files the teammate under its lead, titled by its type and on the model it runs', async () => {
    mocks.chat.mockImplementation((id: string) => id === 'lead-session' ? { id: 5, workspaceId: 9 } : undefined)
    await createTeammateChat(session, member, { id: 'lead-session' }, async () => 'fallback/model')
    expect(mocks.createChat).toHaveBeenCalledWith(expect.objectContaining({
      tp: 'teammate',
      title: 'c1 · Coder',
      workspaceId: 9,
      model: 'anthropic/claude-sonnet-5-5',
      sessionId: 'teammate-session',
      metadata: { peer: { name: 'c1', team: 'team:lead-session:crew', type: 'coder', creatorSessionId: 'lead-session', leadChatId: 5 } },
    }))
  })

  it('finds the lead through the session manager on its first turn', async () => {
    mocks.record.mockImplementation((id: string) => id === 'lead-session' ? { chatId: 6 } : undefined)
    mocks.chatMeta.mockImplementation((id: number) => id === 6 ? { workspaceId: 3 } : undefined)
    await createTeammateChat(session, member, undefined, async () => 'fallback/model')
    expect(mocks.createChat).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 3, metadata: { peer: expect.objectContaining({ leadChatId: 6 }) } }))
  })

  it('falls back to the type key and the default model', async () => {
    mocks.settings.mockResolvedValue({ schema: { type: 'object' }, value: {}, issues: [] })
    await createTeammateChat({ id: 'teammate-session', modelSetting: undefined } as unknown as HarnessSession, member, undefined, async () => 'fallback/model')
    expect(mocks.createChat).toHaveBeenCalledWith(expect.objectContaining({ title: 'c1 · coder', model: 'fallback/model' }))
  })

  it('throws when the row cannot be made, so the spawn is rolled back', async () => {
    mocks.createChat.mockImplementation(() => { throw new Error('disk full') })
    await expect(createTeammateChat(session, member, undefined, async () => 'm')).rejects.toThrow('disk full')
  })
})
