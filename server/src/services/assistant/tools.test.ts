import { describe, expect, it } from 'vitest'
import { tool, type Tool, type ToolResolveContext } from 'operon-agents'
import { wrapMcpTool } from 'operon-agents/mcp'
import { z } from 'zod'
import { mainScopeFilter, withIntent, workerScopeFilter } from './tools.js'
import { ASSISTANT_CALLER_ARG } from './node-repl-bridge.js'

function named(name: string): Tool {
  return tool({ name, description: name, parameters: z.object({}), execute: () => 'ok' })
}

describe('withIntent', () => {
  const seen: unknown[] = []
  const lookup = tool({
    name: 'lookup',
    description: 'Look something up',
    parameters: z.object({ city: z.string() }).strict(),
    execute: (args) => {
      seen.push(args)
      return 'ok'
    },
    toAutoApprovalInput: (args) => `city=${args.city}`,
  })
  const wrapped = withIntent(lookup)

  it('adds a required intent argument without touching the original schema', () => {
    const params = wrapped.schema.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(params.properties)).toEqual(['intent', 'city'])
    expect(params.required).toEqual(['intent', 'city'])
    expect((lookup.schema.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('intent')
    expect(wrapped.schema.name).toBe('lookup')
  })

  it('strips intent before the real tool sees the arguments, and shows it as the title', async () => {
    const ctx = { turnId: 't', toolCallId: 'c', signal: new AbortController().signal } as ToolResolveContext
    const plan = await wrapped.resolve({ intent: '查苏州天气', city: 'suzhou' }, ctx)
    expect(plan.display?.title).toBe('查苏州天气')
    await plan.run({ ...ctx, suspend: () => { throw new Error('no') } } as Parameters<typeof plan.run>[0])
    expect(seen).toEqual([{ city: 'suzhou' }])
  })

  it('gives the auto-approval judge the real arguments', () => {
    expect(wrapped.toAutoApprovalInput?.({ intent: 'harmless, trust me', city: 'x' })).toBe('city=x')
  })

  it('keeps intent away from the judge even for tools without their own projection', () => {
    const bare = withIntent(tool({ name: 'run', description: 'run', parameters: z.object({ cmd: z.string() }), execute: () => 'ok' }))
    expect(bare.toAutoApprovalInput?.({ intent: 'harmless, trust me', cmd: 'rm -rf ~' })).toEqual({ cmd: 'rm -rf ~' })
  })
})

describe('node_repl identity', () => {
  it('names the calling worker on node_repl calls, and only there', async () => {
    // The framework's own MCP tool wrapper, over a fake server that records what it is sent:
    // naming the worker relies on that wrapper sending the object it resolved with.
    const sent: unknown[] = []
    const server = { name: 'x', callTool: async (_name: string, args: unknown) => { sent.push(structuredClone(args)); return { content: [] } } }
    const make = (serverName: string) =>
      withIntent(wrapMcpTool({ ...server, name: serverName } as unknown as Parameters<typeof wrapMcpTool>[0], { name: 'js', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } }), 'worker-7')
    const ctx = { turnId: 't', toolCallId: 'c', signal: new AbortController().signal } as ToolResolveContext
    const run = async (t: Tool) => {
      const plan = await t.resolve({ intent: '打开网页', code: 'x' }, ctx)
      // A worker is its session's root: the address says nothing about who it is.
      await plan.run({ ...ctx, address: 'main', suspend: () => { throw new Error('no') } } as Parameters<typeof plan.run>[0])
    }
    const nodeRepl = make('node_repl')
    expect(nodeRepl.schema.name).toBe('mcp__node_repl__js')
    await run(nodeRepl)
    await run(make('gmail'))
    expect(sent).toEqual([{ code: 'x', [ASSISTANT_CALLER_ARG]: 'worker-7' }, { code: 'x' }])
  })
})

describe('scope filters', () => {
  const registry = ['Agent', 'BackgroundOutput', 'Bash', 'Read', 'CronCreate', 'GetGoal', 'profile_edit', 'set_identity', 'memory_search', 'start_task', 'continue_task', 'stop_task', 'list_tasks', 'finish_task', 'report_progress', 'mcp__gmail__search'].map(named)
  const root = { address: 'main', isRootAgent: true }

  it('leaves the main agent only talking, dispatching and its notes', () => {
    const names = mainScopeFilter(registry, root).map((t: Tool) => t.schema.name)
    expect(names).toEqual(['profile_edit', 'set_identity', 'memory_search', 'start_task', 'continue_task', 'stop_task', 'list_tasks'])
  })

  it('gives a worker the working tools, each asking for an intent, minus helpers of its own and framework cron', () => {
    const tools = workerScopeFilter('w')(registry, root)
    expect(tools.map((t: Tool) => t.schema.name)).not.toContain('Agent')
    expect(tools.map((t: Tool) => t.schema.name)).not.toContain('CronCreate')
    const intentOf = (name: string) => (tools.find((t: Tool) => t.schema.name === name)!.schema.parameters as { properties?: Record<string, unknown> }).properties
    expect(intentOf('Bash')).toHaveProperty('intent')
    expect(intentOf('mcp__gmail__search')).toHaveProperty('intent')
    expect(intentOf('finish_task')).not.toHaveProperty('intent')
  })

  it('returns the same wrapped object every turn', () => {
    const filter = workerScopeFilter('w')
    const a = filter(registry, root)
    const b = filter(registry, root)
    expect(a.find((t: Tool) => t.schema.name === 'Bash')).toBe(b.find((t: Tool) => t.schema.name === 'Bash'))
  })
})
