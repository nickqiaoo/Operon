import { describe, expect, it, vi } from 'vitest'
import type { AgentInput, AgentSession, RuntimeStreamPart } from '@operon/agent-runtime'
import type { AssistantMessage } from '../../../../shared/assistant.js'
import { AssistantProjector, type Cause } from './projector.js'

const createStandaloneSession = vi.hoisted(() => vi.fn())
vi.mock('../ai/state.js', () => ({
  getSessionManager: () => ({ createStandaloneSession }),
}))
vi.mock('../operon-runtime/plugins.js', () => ({ ensurePluginsLoaded: async () => {} }))

// The user's own services, as Settings → MCP and the plugins would give them.
vi.mock('../mcp-config.js', () => ({
  withApiToken: (url: string) => url,
  mcpCliName: (id: string) => ({ codex: 'codex', 'claude-code': 'claude-code', custom: 'operon' })[id],
  userMcpServersForCli: () => ({
    'plugin-linear': { type: 'http', url: 'http://127.0.0.1/api/mcp-gateway/plugin-linear' },
    node_repl: { command: '/somewhere/node_repl' },
    operonrepl: { type: 'http', url: 'http://127.0.0.1/api/operonrepl-mcp?sessionId=old' },
  }),
}))

const { AgentChannel, openRuntimeSession, sessionMcpServers } = await import('./agents.js')

const worker = { role: 'worker' as const, id: 'w1' }

describe('assistant session servers', () => {
  it("gives a worker the user's services, keeping operonrepl its own", () => {
    const servers = sessionMcpServers(worker, true, 'claude-code')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'node_repl', 'assistant_worker', 'operonrepl'])
    expect(servers.operonrepl).toMatchObject({ type: 'http', url: expect.stringContaining('/api/operonrepl-mcp?') })
    expect(servers.operonrepl).toMatchObject({ url: expect.stringContaining('assistantWorker=w1') })
    expect(servers.node_repl).toEqual({ command: '/somewhere/node_repl' })
  })

  it('keeps services away from the main agent, which does no work itself', () => {
    expect(Object.keys(sessionMcpServers({ role: 'main' }, true, 'codex'))).toEqual(['assistant'])
  })

  it('mounts no tools of its own for the wrap-up, which only edits files', () => {
    expect(sessionMcpServers({ role: 'wrapup', id: 'u1' }, true, 'codex')).toEqual({})
  })

  it('mounts operonrepl alongside the external Node REPL on Codex', () => {
    const servers = sessionMcpServers(worker, true, 'codex')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'node_repl', 'assistant_worker', 'operonrepl'])
    expect(servers.node_repl).toEqual({ command: '/somewhere/node_repl' })
    expect(servers.operonrepl).toMatchObject({ type: 'http' })
  })

  it('preserves the external Node REPL when operonrepl is switched off', () => {
    const servers = sessionMcpServers(worker, false, 'codex')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'node_repl', 'assistant_worker'])
    expect(servers.node_repl).toEqual({ command: '/somewhere/node_repl' })
  })

  it('opens a Codex worker without disabling native MCP servers', async () => {
    await openRuntimeSession({
      providerId: 'codex',
      modelId: '',
      kind: 'worker',
      caller: worker,
      cwd: '/workspace',
      instructions: 'Use operonrepl for Computer Use.',
      nodeRepl: true,
    })
    expect(createStandaloneSession).toHaveBeenCalledWith('codex', expect.objectContaining({
      instructions: 'Use operonrepl for Computer Use.',
      codex: { approvedMcpServers: ['assistant_worker'] },
      mcpServers: expect.objectContaining({
        node_repl: { command: '/somewhere/node_repl' },
        operonrepl: expect.objectContaining({ type: 'http' }),
      }),
    }))
  })
})

describe('assistant delivery while a reply is being drafted', () => {
  it('keeps completed commentary, discards an uncommitted Codex draft, and attributes only consumed input', async () => {
    let release!: () => void
    let drafting!: () => void
    let injectionId = ''
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { drafting = resolve })
    const part = (value: Record<string, unknown>) => value as unknown as RuntimeStreamPart
    const inject = vi.fn(async (_text: string, options?: { id?: string }) => { injectionId = options?.id ?? ''; return { delivery: 'accepted' as const, mode: 'steer' as const } })
    const session: AgentSession = {
      id: 'assistant-codex',
      async *send() {
        yield part({ type: 'start' })
        yield part({ type: 'start-step' })
        yield part({ type: 'text-start', id: 'commentary', providerMetadata: { runtime: { messageId: 'a1', completion: 'explicit' } } })
        yield part({ type: 'text-delta', id: 'commentary', text: 'Looking into it.' })
        yield part({ type: 'text-end', id: 'commentary', providerMetadata: { runtime: { completedText: 'Looking into it.' } } })
        yield part({ type: 'text-start', id: 'draft', providerMetadata: { runtime: { messageId: 'a2', completion: 'explicit' } } })
        yield part({ type: 'text-delta', id: 'draft', text: 'I have asked Cod' })
        drafting()
        await gate
        // A stream boundary is not native item/completed: it cannot commit the draft.
        yield part({ type: 'text-end', id: 'draft' })
        yield part({ type: 'injected-input', id: injectionId, text: '[Coding agent finished]' })
        yield part({ type: 'text-start', id: 'final', providerMetadata: { runtime: { messageId: 'a3', completion: 'explicit' } } })
        yield part({ type: 'text-delta', id: 'final', text: 'The checks passed.' })
        yield part({ type: 'text-end', id: 'final', providerMetadata: { runtime: { completedText: 'The checks passed.' } } })
        yield part({ type: 'finish-step', finishReason: 'stop', usage: {} })
        yield part({ type: 'finish', finishReason: 'stop', totalUsage: {} })
      },
      steer: inject,
      abort() { release() },
      async close() {},
      respond: () => true,
    }
    const messages: AssistantMessage[] = []
    let next = 0
    const projector = new AssistantProjector({ message: (m) => { messages.push(m) }, typing: () => {}, activity: () => {} }, () => `m${++next}`)
    const consumed = vi.fn((input: { tag?: unknown }) => projector.setCause(input.tag as Cause))
    const channel = new AgentChannel(session, {
      onTurnStart: (input) => projector.begin(input?.tag as Cause),
      onInputConsumed: consumed,
      onPart: (streamPart) => projector.part(streamPart),
      onTurnEnd: (end) => projector.end(end),
      onApproval: async () => ({ type: 'deny' }),
    })
    try {
      await channel.deliver({ text: 'user question', tag: { kind: 'user' } })
      await started
      expect(messages.map((m) => m.text)).toEqual(['Looking into it.'])
      expect(await channel.deliver({ text: '[Coding agent finished]', tag: { kind: 'coding', activityId: 'coding-1' } })).toBe('injected')
      expect(inject).toHaveBeenCalledWith('[Coding agent finished]', { id: expect.any(String) })
      expect(consumed).not.toHaveBeenCalled()
      release()
      await channel.whenIdle()
      expect(messages.map((m) => m.text)).toEqual(['Looking into it.', 'The checks passed.'])
      expect(messages[0].trigger).toBeUndefined()
      expect(messages[1].trigger).toEqual({ kind: 'coding', activityId: 'coding-1' })
      expect(consumed).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await channel.dispose()
    }
  })
})

describe('assistant independent background output', () => {
  it('waits for the active consumer to finish before projecting a background reply', async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((r) => { release = r }), started = new Promise<void>((r) => { entered = r })
    let background!: (event: import('@operon/agent-runtime').RuntimeBackgroundEvent) => void
    const starts: number[] = [], ends: string[] = [], text: string[] = []
    const session: AgentSession = {
      id: 'background-test',
      async *send() {
        yield { type: 'text-start', id: 'original' }
        yield { type: 'text-delta', id: 'original', text: 'Original' }
        entered(); await gate
        yield { type: 'text-end', id: 'original' }
      },
      onBackground(listener) { background = listener; return () => {} },
      abort() { release() }, async close() { release() }, respond: () => false,
    }
    const channel = new AgentChannel(session, { onApproval: async () => ({ type: 'deny' }), onTurnStart: () => { starts.push(1) },
      onPart: (p) => { if (p.type === 'text-delta') text.push(p.text) }, onTurnEnd: (end) => { ends.push(end.text) } })
    async function* later(): AsyncIterable<RuntimeStreamPart> {
      yield { type: 'text-start', id: 'background' }; yield { type: 'text-delta', id: 'background', text: 'Background' }; yield { type: 'text-end', id: 'background' }
    }
    try {
      await channel.deliver({ text: 'first' }); await started
      background({ type: 'turn', parts: later() })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(starts).toHaveLength(1); expect(text).toEqual(['Original'])
      release()
      for (let i = 0; i < 100 && ends.length < 2; i++) await new Promise((r) => setTimeout(r, 1))
      expect(ends).toEqual(['Original', 'Background'])
      expect(starts).toHaveLength(2)
    } finally { release(); await channel.dispose() }
  })
})
