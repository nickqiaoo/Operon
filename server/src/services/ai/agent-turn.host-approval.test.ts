import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeSession, RuntimeStreamPart } from '@operon/agent-runtime'
import { runAgentTurn } from './agent-turn.js'
import {
  requestHostElicitation,
  resetHostApprovalBroker,
  resolveHostApproval,
} from './host-approval-broker.js'

afterEach(() => {
  resetHostApprovalBroker()
})

describe('runAgentTurn host approval bridge', () => {
  it('injects an external Browser Use approval while the provider stream is paused', async () => {
    let finishProvider: (() => void) | undefined
    const providerPaused = new Promise<void>((resolve) => {
      finishProvider = resolve
    })
    const session: RuntimeSession = {
      async *stream(): AsyncIterable<RuntimeStreamPart> {
        yield { type: 'start' } as RuntimeStreamPart
        yield {
          type: 'tool-call',
          toolCallId: 'outer-tool-call',
          toolName: 'use_tool',
          input: {
            tool_name: 'node_repl__js',
            tool_input: { source: 'await chrome.goto("https://example.com")' },
          },
          dynamic: true,
        } as RuntimeStreamPart
        await providerPaused
        yield {
          type: 'tool-result',
          toolCallId: 'outer-tool-call',
          toolName: 'use_tool',
          input: {},
          output: 'done',
          dynamic: true,
        } as RuntimeStreamPart
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as RuntimeStreamPart
      },
      abort() {},
      async dispose() {},
      resolvePermission() {
        return false
      },
    }

    const turn = runAgentTurn(session, {
      requestId: 'request-1',
      messages: [],
      signal: new AbortController().signal,
      assistantMessageId: 'assistant-1',
      originalMessages: [],
      traffic: {
        chatId: 42,
        providerId: 'fake',
        cwd: '/tmp',
      },
    })
    const reader = turn.preparedParts.getReader()
    expect((await reader.read()).value?.part?.type).toBe('start')
    expect((await reader.read()).value?.part?.type).toBe('tool-call')

    const elicitation = requestHostElicitation(42, {
      message: 'Allow Browser Use to access https://example.com?',
      meta: {
        tool_name: 'access_browser_origin',
        tool_title: 'Access browser origin',
        origin: 'https://example.com',
      },
    })
    const approvalPart = (await reader.read()).value?.part
    expect(approvalPart?.type).toBe('tool-approval-request')
    if (approvalPart?.type !== 'tool-approval-request') {
      throw new Error('Expected a host approval request')
    }
    expect(approvalPart.toolCall.toolCallId).toBe('outer-tool-call')

    expect(resolveHostApproval(42, approvalPart.approvalId, { type: 'allow' })).toBe(true)
    await expect(elicitation).resolves.toEqual({
      action: 'accept',
      _meta: { persist: 'session' },
    })

    finishProvider?.()
    expect((await reader.read()).value?.part?.type).toBe('tool-result')
    while (!(await reader.read()).done) {
      // Drain the provider finish part and close the stream.
    }
    const completed = await turn.done
    expect(completed).toMatchObject({
      message: { id: 'assistant-1', role: 'assistant' },
    })
    const toolParts = completed.message.parts.filter((part) => part.type === 'dynamic-tool')
    expect(toolParts).toHaveLength(1)
    expect(toolParts[0]).toMatchObject({
      toolCallId: 'outer-tool-call',
      state: 'output-available',
    })
  })
})
