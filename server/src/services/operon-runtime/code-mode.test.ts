import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type Model } from '@earendil-works/pi-ai'
import { createHarness, type ExtensionDefinition, type ToolSchema } from 'operon-agents'
import { createModelRuntime, defineModel } from 'operon-agents-core'
import { codeMode, RUN_CODE_NAME } from 'operon-code-mode'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { OperonStreamMapper } from './message-mapper.js'

/**
 * Code Mode as the harness runs it (`index.ts`), seen through the stream the UI gets: a program's
 * nested calls must arrive as parts of their own — a card for the MCP call, and for a call that
 * needs approval, the part BEFORE the approval request that hangs on it (the approval handler
 * pushes into the same queue as the mapper, as `session.ts` does).
 */

function fauxModel() {
  const handle = fauxProvider()
  const runtime = createModelRuntime({ builtins: false })
  runtime.models.setProvider(handle.provider)
  return { handle, model: defineModel({ runtime, descriptor: handle.getModel() as Model<Api> }) }
}

const scheduleServer: ExtensionDefinition = {
  id: 'fake-schedule-mcp',
  session(api) {
    api.registerTool({
      name: 'mcp__schedule__schedule_create',
      description: 'Create a scheduled task.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execute: (args: unknown) => JSON.stringify({ task: { id: 7, name: (args as { name: string }).name, enabled: true } }),
    })
  },
}

function requestSpy(seen: { tools?: readonly ToolSchema[] }): ExtensionDefinition {
  return {
    id: 'request-spy',
    session(api) {
      api.on('model.request', (event) => {
        seen.tools = event.request.tools
        return undefined
      })
    },
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'operon-code-mode-'))
afterEach(() => rmSync(path.join(work, 'out.txt'), { force: true }))

describe('Code Mode through the operon stream', () => {
  it('hides MCP tools behind RunCode and surfaces each nested call as its own part, approval after its card', async () => {
    const { handle, model } = fauxModel()
    const seen: { tools?: readonly ToolSchema[] } = {}
    const harness = createHarness({
      model,
      workDir: work,
      permission: { mode: 'manual' },
      extensions: [scheduleServer, codeMode(), requestSpy(seen)],
    })
    const session = await harness.createSession()
    const mapper = new OperonStreamMapper()
    const parts: RuntimeStreamPart[] = []
    session.onEvent((event) => {
      parts.push(...mapper.map(event))
    })
    session.setApprovalHandler(async (request) => {
      parts.push({
        type: 'tool-approval-request',
        approvalId: `approval-${request.toolCallId}`,
        toolCall: { type: 'tool-call', toolCallId: request.toolCallId, toolName: request.toolName, input: {}, dynamic: true },
      } as unknown as RuntimeStreamPart)
      return { decision: 'approved' }
    })
    handle.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RUN_CODE_NAME, {
          code: `const created = await tools["mcp__schedule__schedule_create"]({ name: "nightly" });
await tools.Bash({ command: "echo ok > out.txt" });
return created;`,
          description: 'Schedule and write',
        }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('done', { stopReason: 'stop' }),
    ])
    const result = await session.prompt('go')
    await harness.close()

    expect(result.status).toBe('completed')
    const offered = seen.tools?.map((tool) => tool.name) ?? []
    expect(offered).toContain(RUN_CODE_NAME)
    expect(offered).not.toContain('mcp__schedule__schedule_create')

    type Call = { type: 'tool-call'; toolCallId: string; toolName: string; providerMetadata?: { operon?: { programToolCallId?: string } } }
    const calls = parts.filter((part): part is RuntimeStreamPart & Call => part.type === 'tool-call') as Call[]
    const program = calls.find((call) => call.toolName === RUN_CODE_NAME)
    const schedule = calls.find((call) => call.toolName === 'mcp__schedule__schedule_create')
    const bash = calls.find((call) => call.toolName === 'Bash')
    expect(schedule?.providerMetadata?.operon?.programToolCallId).toBe(program?.toolCallId)
    expect(bash?.providerMetadata?.operon?.programToolCallId).toBe(program?.toolCallId)

    // The schedule card has the output it parses.
    const scheduleResult = parts.find((part) => part.type === 'tool-result' && part.toolCallId === schedule?.toolCallId) as { output?: unknown } | undefined
    expect(String(scheduleResult?.output)).toContain('"id":7')

    // Each approval (manual mode asks for both calls) names its nested call and comes after its part.
    const approvals = parts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part.type === 'tool-approval-request') as Array<{ part: { toolCall: { toolCallId: string; toolName: string } }; index: number }>
    expect(approvals.map(({ part }) => [part.toolCall.toolCallId, part.toolCall.toolName])).toEqual([
      [schedule?.toolCallId, 'mcp__schedule__schedule_create'],
      [bash?.toolCallId, 'Bash'],
    ])
    for (const { part, index } of approvals) {
      expect(parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === part.toolCall.toolCallId)).toBeLessThan(index)
    }
  })
})
