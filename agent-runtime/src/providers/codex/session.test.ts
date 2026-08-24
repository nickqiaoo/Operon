import { describe, expect, it, vi } from 'vitest'
import { createResponseForDecision } from './approval-response.js'
import { resolveCodexModeConfig, resolveCodexModeId } from './config.js'
import { withLocalMcpNoProxy } from './local-mcp-env.js'
import { buildThinkingLevelsFromModelInfo, mapModelInfoToDescriptor } from './model-info.js'
import { buildConfigOverrides } from './sdk/converters/settings-merger.js'
import type { ModelInfo } from './sdk/protocol/messages.js'
import { CodexRuntimeSession } from './session.js'

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

describe('Codex MCP status', () => {
  it('lists every app-server status page and maps it to the Session panel shape', async () => {
    const session = new CodexRuntimeSession({
      cwd: '/tmp',
      sessionId: 'thread-1',
      mcpServers: {
        browser: {
          type: 'http',
          url: 'http://127.0.0.1:3000/mcp',
        },
      },
    })
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

    await expect(session.agentControl('mcp.list', undefined)).resolves.toEqual({
      servers: [
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
      ],
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(1, 'mcpServerStatus/list', {
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
      threadId: 'thread-1',
    })
  })

  it('keeps Codex MCP controls read-only', async () => {
    const session = new CodexRuntimeSession({ cwd: '/tmp' })

    await expect(session.agentControl('mcp.reconnect', { name: 'browser' })).rejects.toThrow(
      'Unsupported Codex session control method: mcp.reconnect',
    )
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
