import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import type { StorageAdapter } from '../../storage/interface.js'
import { initComputerUseConfig } from '../computer-use-config.js'
import {
  attachHostApprovalStream,
  observeHostApprovalStreamPart,
  requestHostElicitation,
  resetHostApprovalBroker,
  resolveHostApproval,
} from './host-approval-broker.js'

function createMemoryStorage(): StorageAdapter {
  const values = new Map<string, unknown>()
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => { values.set(key, value) },
    delete: (key: string) => { values.delete(key) },
    getAll: <T>() => Object.fromEntries(values) as T,
    setAll: <T>(data: T) => {
      values.clear()
      if (data != null && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) values.set(key, value)
      }
    },
    keys: (prefix = '') => [...values.keys()].filter((key) => key.startsWith(prefix)),
  }
}

afterEach(() => {
  resetHostApprovalBroker()
  initComputerUseConfig(createMemoryStorage())
})

describe('host approval broker', () => {
  it('injects an approval into the active stream and resolves a session grant', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(42, (part) => events.push(part))
    observeHostApprovalStreamPart(42, {
      type: 'tool-call',
      toolCallId: 'outer-tool-call',
      toolName: 'use_tool',
      input: {
        tool_name: 'node_repl__js',
        tool_input: { source: 'await chrome.goto("https://www.bilibili.com")' },
      },
      dynamic: true,
    })

    const resultPromise = requestHostElicitation(42, {
      message: 'Allow Browser Use to access https://www.bilibili.com?',
      meta: {
        connector_name: 'Browser Use',
        tool_title: 'Access browser origin',
        origin: 'https://www.bilibili.com',
      },
    })

    expect(events.map((event) => event.type)).toEqual(['tool-approval-request'])
    const request = events[0] as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    expect(request.toolCall.toolCallId).toBe('outer-tool-call')
    expect(resolveHostApproval(42, request.approvalId, { type: 'allow' })).toBe(true)
    await expect(resultPromise).resolves.toEqual({
      action: 'accept',
      _meta: { persist: 'session' },
    })
    expect(events.map((event) => event.type)).toEqual(['tool-approval-request'])
  })

  it('maps allow-always and deny to elicitation persistence semantics', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(7, (part) => events.push(part))
    observeHostApprovalStreamPart(7, {
      type: 'tool-call',
      toolCallId: 'outer-tool-call',
      toolName: 'node_repl__js',
      input: {},
      dynamic: true,
    })

    const alwaysPromise = requestHostElicitation(7, { message: 'Allow this origin?' })
    const alwaysRequest = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    resolveHostApproval(7, alwaysRequest.approvalId, { type: 'allow-always' })
    await expect(alwaysPromise).resolves.toEqual({
      action: 'accept',
      _meta: { persist: 'always' },
    })

    const denyPromise = requestHostElicitation(7, { message: 'Allow this app?' })
    const denyRequest = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    resolveHostApproval(7, denyRequest.approvalId, { type: 'deny' })
    await expect(denyPromise).resolves.toEqual({ action: 'decline' })
    expect(events.at(-1)?.type).toBe('tool-approval-request')
  })

  it('fails closed when no active host stream exists', async () => {
    await expect(requestHostElicitation(99, { message: 'Allow?' })).resolves.toEqual({
      action: 'cancel',
    })
  })

  it('synthesizes a standalone approval when no owning tool call has been emitted', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(100, (part) => events.push(part))

    // The normal Browser Use case: the outer node_repl call is still running, so
    // the provider has not emitted its `tool-call` part yet.
    const result = requestHostElicitation(100, {
      message: 'Allow Browser Use to access https://www.baidu.com?',
      meta: {
        connector_id: 'browser-use',
        tool_name: 'access_browser_origin',
        tool_params: { origin: 'https://www.baidu.com' },
      },
    })

    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    expect(approval.type).toBe('tool-approval-request')
    expect(approval.toolCall.toolCallId).toBe(approval.approvalId)
    expect(approval.toolCall.toolName).toBe('access_browser_origin')
    expect(approval.toolCall.input).toEqual({ origin: 'https://www.baidu.com' })

    // The synthesized call must reach the stream as its own part. Consumers
    // resolve an approval against the message assembled so far, so emitting
    // only the approval leaves them with an id they have never seen — the AI
    // SDK assembler throws "No tool invocation found for tool call ID" and the
    // whole turn is lost.
    const emittedCall = events.at(-2) as Extract<RuntimeTextStreamPart, { type: 'tool-call' }>
    expect(emittedCall.type).toBe('tool-call')
    expect(emittedCall.toolCallId).toBe(approval.approvalId)
    expect(emittedCall.toolName).toBe('access_browser_origin')

    resolveHostApproval(100, approval.approvalId, { type: 'allow' })
    await expect(result).resolves.toEqual({ action: 'accept', _meta: { persist: 'session' } })

    // …and it has to be settled too: nothing else owns it, so without this the
    // card stays "waiting for approval" after the user has already answered.
    const settled = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-result' }>
    expect(settled.type).toBe('tool-result')
    expect(settled.toolCallId).toBe(approval.approvalId)
  })

  it('settles a denied synthesized card so it stops reading as pending', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(102, (part) => events.push(part))

    const result = requestHostElicitation(102, {
      message: 'Allow Browser Use to access https://www.baidu.com?',
      meta: {
        connector_id: 'browser-use',
        tool_name: 'access_browser_origin',
        tool_params: { origin: 'https://www.baidu.com' },
      },
    })
    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

    resolveHostApproval(102, approval.approvalId, { type: 'deny' })
    await expect(result).resolves.toEqual({ action: 'decline' })

    const settled = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-output-denied' }>
    expect(settled.type).toBe('tool-output-denied')
    expect(settled.toolCallId).toBe(approval.approvalId)
  })

  it('leaves a provider-owned card for the provider to settle', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(103, (part) => events.push(part))
    observeHostApprovalStreamPart(103, {
      type: 'tool-call',
      toolCallId: 'outer-tool-call',
      toolName: 'node_repl__js',
      input: {},
      dynamic: true,
    })

    const result = requestHostElicitation(103, { message: 'Allow?' })
    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    expect(approval.toolCall.toolCallId).toBe('outer-tool-call')

    resolveHostApproval(103, approval.approvalId, { type: 'allow' })
    await result

    // Only the approval — the running tool emits its own result, and closing it
    // here would end the card while the tool is still working.
    expect(events).toHaveLength(1)
  })

  it('gives concurrent approvals on one owning call distinct cards', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(104, (part) => events.push(part))
    observeHostApprovalStreamPart(104, {
      type: 'tool-call',
      toolCallId: 'shared-outer-call',
      toolName: 'node_repl__js',
      input: {},
      dynamic: true,
    })

    const firstResult = requestHostElicitation(104, { message: 'Allow the first action?' })
    const firstApproval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    const secondResult = requestHostElicitation(104, {
      message: 'Allow the second action?',
      meta: { tool_name: 'second_action', tool_params: { value: 2 } },
    })
    const secondApproval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

    expect(firstApproval.toolCall.toolCallId).toBe('shared-outer-call')
    expect(secondApproval.toolCall.toolCallId).toBe(secondApproval.approvalId)
    expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId)
    expect(events.at(-2)).toMatchObject({
      type: 'tool-call',
      toolCallId: secondApproval.approvalId,
      toolName: 'second_action',
    })

    expect(resolveHostApproval(104, firstApproval.approvalId, { type: 'allow' })).toBe(true)
    expect(resolveHostApproval(104, secondApproval.approvalId, { type: 'deny' })).toBe(true)
    await expect(firstResult).resolves.toMatchObject({ action: 'accept' })
    await expect(secondResult).resolves.toEqual({ action: 'decline' })
  })

  it('synthesizes a Computer Use approval and still honours its persistence', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(101, (part) => events.push(part))

    const request = {
      message: 'Allow Computer Use to use "TextEdit"?',
      meta: {
        connector_id: 'computer-use',
        persist: ['session', 'always'],
        tool_params: { app: 'com.apple.TextEdit' },
      },
    }

    const first = requestHostElicitation(101, request)
    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    expect(approval.toolCall.toolName).toBe('computer-use')
    expect(approval.toolCall.toolCallId).toBe(approval.approvalId)

    resolveHostApproval(101, approval.approvalId, { type: 'allow' })
    await expect(first).resolves.toEqual({ action: 'accept', _meta: { persist: 'session' } })

    // The session grant still applies, so no second card is rendered.
    await expect(requestHostElicitation(101, request)).resolves.toEqual({
      action: 'accept',
      content: { source: 'computer-use-persisted-state' },
      _meta: { persist: 'session' },
    })
    expect(events.filter((event) => event.type === 'tool-approval-request')).toHaveLength(1)
  })

  it('releases a pending approval when the turn stream detaches', async () => {
    const detach = attachHostApprovalStream(102, () => {})
    const result = requestHostElicitation(102, { message: 'Allow?' })
    detach()
    await expect(result).resolves.toEqual({ action: 'cancel' })
  })

  it('reuses a session Computer Use app approval without rendering another request', async () => {
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(11, (part) => events.push(part))
    observeHostApprovalStreamPart(11, {
      type: 'tool-call',
      toolCallId: 'computer-use-call',
      toolName: 'node_repl__js',
      input: {},
      dynamic: true,
    })
    const request = {
      message: 'Allow Computer Use to use "TextEdit"?',
      meta: {
        connector_id: 'computer-use',
        persist: ['session', 'always'],
        tool_params: { app: 'com.apple.TextEdit' },
      },
    }

    const firstResult = requestHostElicitation(11, request)
    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    resolveHostApproval(11, approval.approvalId, { type: 'allow' })
    await expect(firstResult).resolves.toEqual({
      action: 'accept',
      _meta: { persist: 'session' },
    })

    await expect(requestHostElicitation(11, request)).resolves.toEqual({
      action: 'accept',
      content: { source: 'computer-use-persisted-state' },
      _meta: { persist: 'session' },
    })
    expect(events).toHaveLength(1)
  })

  it('reuses an always Computer Use approval across chats only when policy permits it', async () => {
    const storage = createMemoryStorage()
    initComputerUseConfig(storage)
    const request = {
      message: 'Allow Computer Use to use "TextEdit"?',
      meta: {
        connector_id: 'computer-use',
        persist: ['session', 'always'],
        tool_params: { app: 'com.apple.TextEdit' },
      },
    }
    const events: RuntimeTextStreamPart[] = []
    attachHostApprovalStream(12, (part) => events.push(part))
    observeHostApprovalStreamPart(12, {
      type: 'tool-call',
      toolCallId: 'computer-use-call',
      toolName: 'node_repl__js',
      input: {},
      dynamic: true,
    })

    const firstResult = requestHostElicitation(12, request)
    const approval = events.at(-1) as Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>
    resolveHostApproval(12, approval.approvalId, { type: 'allow-always' })
    await firstResult
    resetHostApprovalBroker()

    await expect(requestHostElicitation(13, request)).resolves.toEqual({
      action: 'accept',
      content: { source: 'computer-use-persisted-state' },
      _meta: { persist: 'always' },
    })

    const sessionOnlyRequest = {
      ...request,
      meta: {
        ...request.meta,
        persist: ['session'],
      },
    }
    await expect(requestHostElicitation(13, sessionOnlyRequest)).resolves.toEqual({
      action: 'cancel',
    })
  })
})
