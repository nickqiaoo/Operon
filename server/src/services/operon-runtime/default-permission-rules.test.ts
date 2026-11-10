import { PermissionManager, type AutoApprover, type PermissionRule } from 'operon-agents'
import { describe, expect, it, vi } from 'vitest'
import { toolsFor } from '../assistant/tools.js'
import { DEFAULT_PERMISSION_RULES, withDefaultPermissionRules } from './default-permission-rules.js'

async function authorize(toolName: string, rules: readonly PermissionRule[]) {
  const classify = vi.fn(async () => ({ decision: 'escalate' as const, reason: 'unsure' }))
  const manager = new PermissionManager({
    mode: 'auto',
    rules,
    autoApprover: { classify } as AutoApprover,
    responder: { requestApproval: async () => ({ decision: 'rejected' }) } as never,
  })
  const result = await manager.authorize({
    toolCall: { id: 'call', name: toolName, arguments: {} },
    args: {},
    tool: undefined,
    signal: new AbortController().signal,
    plan: { approvalRule: toolName, run: async () => ({ content: [] }) },
  } as never)
  return { result, judged: classify.mock.calls.length }
}

const patterns = DEFAULT_PERMISSION_RULES.map((rule) => rule.pattern)

describe('default permission rules', () => {
  it('name tools the background sessions really have', () => {
    const real = (['heartbeat', 'worker'] as const).flatMap((role) =>
      toolsFor(role).map((tool) => `mcp__assistant_${role}__${tool.name}`),
    )
    expect(real).toEqual(expect.arrayContaining(patterns))
  })

  it.each(patterns)('let %s run without the judge', async (toolName) => {
    expect(await authorize(toolName, withDefaultPermissionRules([]))).toEqual({ result: undefined, judged: 0 })
  })

  it('leave every other tool of the assistant to the judge', async () => {
    const { judged } = await authorize('mcp__assistant__board_create', withDefaultPermissionRules([]))
    expect(judged).toBe(1)
  })

  it.each(['deny', 'ask'] as const)('yield to a user %s rule', async (decision) => {
    const pattern = 'mcp__assistant_heartbeat__heartbeat_done'
    const { result } = await authorize(pattern, withDefaultPermissionRules([{ decision, scope: 'user', pattern }]))
    expect(result).toMatchObject({ block: true })
  })
})
