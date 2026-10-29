import { describe, expect, it, vi } from 'vitest'
import { createResponseForDecision } from './approval-response.js'
import { resolveCodexModeConfig, resolveCodexModeId, toSandboxPolicy } from './config.js'
import { withLocalMcpNoProxy } from './local-mcp-env.js'
import { buildThinkingLevelsFromModelInfo, mapModelInfoToDescriptor } from './model-info.js'
import { buildConfigOverrides } from './sdk/converters/settings-merger.js'
import type { ModelInfo } from './sdk/protocol/messages.js'
import { CodexRuntimeSession, disabledMcpConfig } from './session.js'
import { createRuntimeContext } from '../../context.js'

const ctx = createRuntimeContext()

const createModelInfo = (
  overrides: Partial<ModelInfo> = {},
): ModelInfo => ({
  id: 'gpt-5.4',
  model: 'gpt-5.4',
  displayName: 'GPT-5.4',
  description: 'Balanced Codex model',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Low reasoning' },
    { reasoningEffort: 'medium', description: 'Medium reasoning' },
    { reasoningEffort: 'high', description: 'High reasoning' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning' },
  ],
  defaultReasoningEffort: 'high',
  isDefault: true,
  ...overrides,
})

describe('Codex model info mapping', () => {
  it('uses app-server reasoning efforts as model capabilities', () => {
    const descriptor = mapModelInfoToDescriptor(createModelInfo())

    expect(descriptor.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('builds provider thinking options from app-server model info', () => {
    const levels = buildThinkingLevelsFromModelInfo([
      createModelInfo({
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low reasoning' },
          { reasoningEffort: 'high', description: 'High reasoning' },
        ],
      }),
      createModelInfo({
        id: 'gpt-5.4-codex',
        supportedReasoningEfforts: [
          { reasoningEffort: 'high', description: 'High reasoning' },
          { reasoningEffort: 'xhigh', description: 'Extra high reasoning' },
        ],
      }),
    ])

    expect(levels).toEqual([
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra High' },
    ])
  })
})

describe('Codex permission modes', () => {
  it('uses the new request approval mode id as the default fallback', () => {
    expect(resolveCodexModeId()).toBe('requestApproval')
    expect(resolveCodexModeId('unknown')).toBe('requestApproval')
  })

  it('maps approve-for-me to app-server auto review over the workspace profile', () => {
    expect(resolveCodexModeConfig('approveForMe')).toEqual({
      approvalMode: 'on-request',
      sandboxMode: 'workspace-write',
      approvalsReviewer: 'auto_review',
      defaultPermissions: ':workspace',
    })
  })

  it('maps full access to the app-server danger profile without bypassing approvals', () => {
    expect(resolveCodexModeConfig('fullAccess')).toEqual({
      approvalMode: 'on-request',
      sandboxMode: 'danger-full-access',
      approvalsReviewer: 'user',
      defaultPermissions: ':danger-full-access',
    })
  })

  it('maps plan mode to read-only permissions', () => {
    expect(resolveCodexModeConfig('plan')).toEqual({
      approvalMode: 'on-request',
      sandboxMode: 'read-only',
      approvalsReviewer: 'user',
      defaultPermissions: ':read-only',
    })
  })
})

describe('Codex app-server config overrides', () => {
  it('passes default permissions through the app-server config key', () => {
    expect(buildConfigOverrides({ defaultPermissions: ':workspace' })).toEqual({
      default_permissions: ':workspace',
    })
  })

  it('lets the selected mode override raw default_permissions config', () => {
    expect(
      buildConfigOverrides({
        defaultPermissions: ':danger-full-access',
        configOverrides: { default_permissions: ':workspace' },
      }),
    ).toEqual({
      default_permissions: ':danger-full-access',
    })
  })
})

describe('Codex writable dirs', () => {
  // Measured with codex-cli 0.162.1 under the `:workspace` permission profile: a write outside
  // cwd is refused ("operation not permitted") without these, and goes through with them.
  it('hands them to the thread as sandbox writable roots and to each turn in its policy', () => {
    const session = new CodexRuntimeSession({ cwd: '/home/a/ws', writableDirs: ['/home/a'] }, createRuntimeContext({ resolveBinary: () => '/mock/codex' }))
    const settings = (session as unknown as { buildSettings(): Parameters<typeof buildConfigOverrides>[0] }).buildSettings()
    expect(buildConfigOverrides(settings)).toMatchObject({ 'sandbox_workspace_write.writable_roots': ['/home/a'] })
    expect(toSandboxPolicy('workspace-write', ['/home/a'])).toEqual({ type: 'workspaceWrite', writableRoots: ['/home/a'] })
  })

  it('leaves the policy as it was without any', () => {
    expect(toSandboxPolicy('workspace-write')).toEqual({ type: 'workspaceWrite' })
    expect(toSandboxPolicy('read-only', ['/home/a'])).toEqual({ type: 'readOnly' })
  })
})

describe('Codex disabled MCP servers', () => {
  it('switches off a server the user config defines, as a flat app-server key', () => {
    const overrides = disabledMcpConfig(['node_repl'], { node_repl: { command: '/x' }, playwright: {} })
    expect(overrides).toEqual({ mcp_servers: { node_repl: { enabled: false } } })
    expect(buildConfigOverrides({ configOverrides: overrides })).toEqual({ 'mcp_servers.node_repl.enabled': false })
  })

  it('leaves out a name the config does not define (a bare `enabled` is an invalid entry)', () => {
    expect(disabledMcpConfig(['node_repl'], { playwright: {} })).toBeUndefined()
    expect(disabledMcpConfig(['node_repl', 'playwright'], { playwright: {} })).toEqual({
      mcp_servers: { playwright: { enabled: false } },
    })
  })
})

describe('Codex approved MCP servers', () => {
  // Measured with codex-cli 0.162.1: `approve` is accepted (`auto | prompt | writes | approve`).
  it('marks only the named servers to run their tools without an approval step', () => {
    const session = new CodexRuntimeSession(
      {
        cwd: '/tmp',
        mcpServers: { assistant_heartbeat: { type: 'http', url: 'http://127.0.0.1/a' }, playwright: { command: '/x' } },
        codex: { approvedMcpServers: ['assistant_heartbeat'] },
      },
      createRuntimeContext({ resolveBinary: () => '/mock/codex' }),
    )
    const settings = (session as unknown as { buildSettings(): Parameters<typeof buildConfigOverrides>[0] }).buildSettings()
    const keys = buildConfigOverrides(settings) ?? {}
    expect(keys['mcp_servers.assistant_heartbeat.default_tools_approval_mode']).toBe('approve')
    // Dotted keys are flat here — check the key list, not a property path.
    expect(Object.keys(keys)).not.toContain('mcp_servers.playwright.default_tools_approval_mode')
  })
})

describe('Codex MCP status', () => {
  it('lists every app-server status page and maps it to the Session panel shape', async () => {
    const session = new CodexRuntimeSession({
      cwd: '/tmp',
      resume: 'thread-1',
      mcpServers: {
        browser: {
          type: 'http',
          url: 'http://127.0.0.1:3000/mcp',
        },
      },
    }, ctx)
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe('mcpServerStatus/list')
      const cursor = (params as { cursor?: string | null } | undefined)?.cursor
      if (cursor == null) {
        return {
          data: [
            {
              name: 'browser',
              serverInfo: { name: 'browser', version: '1.0.0' },
              tools: { open: {}, click: {} },
              authStatus: 'unsupported',
            },
          ],
          nextCursor: 'page-2',
        }
      }
      expect(cursor).toBe('page-2')
      return {
        data: [
          {
            name: 'private-server',
            serverInfo: null,
            tools: {},
            authStatus: 'notLoggedIn',
          },
        ],
        nextCursor: null,
      }
    })
    Object.assign(session, { client: { request } })

    await expect(session.native.mcp.list()).resolves.toEqual([
        {
          name: 'browser',
          status: 'connected',
          transport: 'http',
          toolCount: 2,
        },
        {
          name: 'private-server',
          status: 'needs-auth',
          toolCount: 0,
        },
      ])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(1, 'mcpServerStatus/list', {
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
      threadId: 'thread-1',
    })
  })

  it('keeps Codex MCP controls read-only', () => {
    const session = new CodexRuntimeSession({ cwd: '/tmp' }, ctx)

    expect(Object.keys(session.native.mcp)).toEqual(['list'])
  })
})

describe('createResponseForDecision', () => {
  it('maps command approvals to the codex protocol decisions', () => {
    expect(createResponseForDecision('command', { type: 'allow' })).toEqual({
      decision: 'accept',
    })
    expect(createResponseForDecision('command', { type: 'allow-always' })).toEqual({
      decision: 'acceptForSession',
    })
    expect(createResponseForDecision('command', { type: 'deny' })).toEqual({
      decision: 'decline',
    })
  })

  it('maps file approvals to the codex protocol decisions', () => {
    expect(createResponseForDecision('fileChange', { type: 'allow' })).toEqual({
      decision: 'accept',
    })
    expect(createResponseForDecision('fileChange', { type: 'allow-always' })).toEqual({
      decision: 'acceptForSession',
    })
    expect(createResponseForDecision('fileChange', { type: 'deny' })).toEqual({
      decision: 'decline',
    })
  })
})

describe('withLocalMcpNoProxy', () => {
  it('adds localhost bypasses without dropping existing no-proxy hosts', () => {
    expect(
      withLocalMcpNoProxy({
        HTTP_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'example.com, 10.0.0.0/8',
        no_proxy: 'internal.local',
      }),
    ).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'example.com,10.0.0.0/8,127.0.0.1,localhost,::1',
      no_proxy: 'internal.local,127.0.0.1,localhost,::1',
    })
  })

  it('sets both uppercase and lowercase no-proxy variables when absent', () => {
    expect(withLocalMcpNoProxy({})).toEqual({
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    })
  })
})

describe('Codex goal pursuit', () => {
  function harness(turnCount = 1) {
    type Handler = (params: unknown) => void
    const handlers = new Map<string, Set<Handler>>()
    const emit = (method: string, params: unknown) => {
      for (const handler of handlers.get(method) ?? []) handler(params)
    }
    let turns = 0
    const snapshot = (status: 'active' | 'complete') => ({ threadId: 'thread-goal', objective: 'Finish', status, tokensUsed: turns * 100 })
    const client = {
      onNotification: (method: string, handler: Handler) => {
        const set = handlers.get(method) ?? new Set<Handler>()
        set.add(handler)
        handlers.set(method, set)
        return () => set.delete(handler)
      },
      onRequest: () => () => {},
      readRateLimits: async () => null,
      setGoal: vi.fn(async () => {
        turns += 1
        // A whole fast turn may arrive before the goal/set promise resumes.
        emit('turn/started', { threadId: 'thread-goal', turn: { id: `turn-${turns}` } })
        emit('item/agentMessage/delta', { threadId: 'thread-goal', turnId: `turn-${turns}`, itemId: `text-${turns}`, delta: 'Done' })
        emit('turn/completed', { threadId: 'thread-goal', turn: { id: `turn-${turns}`, status: 'completed' } })
        return { goal: snapshot('active') }
      }),
      getGoal: vi.fn(async () => ({ goal: turns < turnCount ? snapshot('active') : null })),
    }
    const session = new CodexRuntimeSession({ cwd: '/tmp', model: 'gpt-5', effort: 'xhigh' }, createRuntimeContext({ resolveBinary: () => '/mock/codex' }))
    const internals = session as unknown as {
      getClient(): typeof client
      resolveThreadId(): Promise<string>
      delay(): Promise<void>
    }
    vi.spyOn(internals, 'getClient').mockReturnValue(client)
    vi.spyOn(internals, 'resolveThreadId').mockResolvedValue('thread-goal')
    vi.spyOn(internals, 'delay').mockResolvedValue(undefined)
    return { session, client, handlers, internals }
  }

  it('captures fast auto-started turns and handles a cleared goal returned by goal/get', async () => {
    const { session, client, handlers, internals } = harness()
    const parts = []
    for await (const part of session.goal.run('Finish')) parts.push(part)
    expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Done' }))
    expect(parts).toContainEqual({ type: 'message-metadata', metadata: expect.objectContaining({ goal: null }) })
    expect(client.setGoal).toHaveBeenCalledWith(expect.objectContaining({ origin: 'user', objective: 'Finish' }))
    expect(internals.resolveThreadId).toHaveBeenCalledWith(client, expect.objectContaining({ configOverrides: expect.objectContaining({ model_reasoning_effort: 'xhigh' }) }), undefined, 'persistent')
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true)
  })

  it('continues beyond 50 turns without inventing a user budget and marks continuations automatic', async () => {
    const { session, client } = harness(51)
    for await (const _part of session.goal.run('Finish')) { /* drain */ }
    expect(client.setGoal).toHaveBeenCalledTimes(51)
    expect(client.setGoal).toHaveBeenNthCalledWith(2, expect.objectContaining({ origin: 'automatic', objective: undefined }))
  })
})
