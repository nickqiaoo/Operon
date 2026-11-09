import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type Model } from '@earendil-works/pi-ai'
import { createHarness } from 'operon-agents'
import { createModelRuntime, defineModel } from 'operon-agents-core'
import { OperonStreamMapper } from './message-mapper.js'

/**
 * The real engine's order: a top-level call asks for approval BEFORE `tool.call.started`, and its
 * approval request carries no arguments. `session.ts` reads them from the mapper at that moment.
 */
describe('tool input at approval time', () => {
  it('has the arguments of a top-level call the engine is asking about', async () => {
    const handle = fauxProvider()
    const runtime = createModelRuntime({ builtins: false })
    runtime.models.setProvider(handle.provider)
    const model = defineModel({ runtime, descriptor: handle.getModel() as Model<Api> })
    const harness = createHarness({
      model,
      workDir: mkdtempSync(path.join(tmpdir(), 'operon-approval-input-')),
      permission: { mode: 'manual' },
    })
    const session = await harness.createSession()
    const mapper = new OperonStreamMapper()
    const startedBeforeApproval: string[] = []
    session.onEvent((event) => {
      if (event.type === 'tool.call.started') startedBeforeApproval.push(event.toolCallId)
      mapper.map(event)
    })
    const seen: Array<{ toolName: string; input: unknown; started: boolean }> = []
    session.setApprovalHandler(async (request) => {
      seen.push({
        toolName: request.toolName,
        input: mapper.toolInput(request.toolCallId),
        started: startedBeforeApproval.includes(request.toolCallId),
      })
      return { decision: 'rejected' }
    })
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall('Bash', { command: 'git push', description: 'Push' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done', { stopReason: 'stop' }),
    ])

    await session.prompt('go')
    await harness.close()

    expect(seen).toEqual([
      { toolName: 'Bash', input: { command: 'git push', description: 'Push' }, started: false },
    ])
  })
})
