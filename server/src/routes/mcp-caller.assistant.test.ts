import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENCODE_CALLER_ARG } from '@operon/agent-runtime/opencode'
import { bindOpencodeCaller } from '../../../agent-runtime/src/providers/opencode/caller-identity.js'
import {
  ASSISTANT_KEY_PARAM,
  ASSISTANT_WORKER_PARAM,
  assistantConversationId,
  assistantKeyQuery,
  isAssistantMountKey,
  parseAssistantConversation,
} from '../services/assistant/node-repl-bridge.js'
import { resolveMcpCallerChat } from './mcp-caller.js'

describe('isAssistantMountKey', () => {
  it("accepts only this process's key", () => {
    const key = new URLSearchParams(assistantKeyQuery()).get(ASSISTANT_KEY_PARAM) ?? ''
    expect(isAssistantMountKey(key)).toBe(true)
    expect(isAssistantMountKey(undefined)).toBe(false)
    expect(isAssistantMountKey('')).toBe(false)
    expect(isAssistantMountKey(`${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`)).toBe(false)
    expect(isAssistantMountKey(key.slice(1))).toBe(false)
  })
})

describe('assistant conversation ids', () => {
  it('round-trip, and nothing else parses as one', () => {
    for (const caller of [{ role: 'main' as const }, { role: 'worker' as const, id: 'w-1' }, { role: 'wrapup' as const, id: 'u2' }]) {
      expect(parseAssistantConversation(assistantConversationId(caller))).toEqual(caller)
    }
    expect(parseAssistantConversation('42')).toBeUndefined()
    expect(parseAssistantConversation('assistant:worker:../x')).toBeUndefined()
  })
})

describe('resolveMcpCallerChat on the assistant URLs', () => {
  let base = ''
  let close: () => Promise<void> = async () => {}

  beforeAll(async () => {
    const app = new Hono()
    app.post('/mcp', async (c) => {
      const resolution = await resolveMcpCallerChat(c, 'sessionId')
      return resolution.ok
        ? c.json({ chatId: resolution.chatId, worker: resolution.assistantWorker ?? null, body: resolution.body })
        : resolution.response
    })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  })
  afterAll(() => close())

  const call = async (query: string, args: Record<string, unknown> = { code: '1' }) => {
    const response = await fetch(`${base}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: args } }),
    })
    return (await response.json()) as {
      chatId?: number | null
      worker?: string | null
      body?: { params: { arguments: Record<string, unknown> } }
      result?: { isError?: boolean }
    }
  }

  it('routes to the worker its URL names, with the key', async () => {
    const result = await call(`?${assistantKeyQuery()}&${ASSISTANT_WORKER_PARAM}=w1`)
    expect(result.worker).toBe('w1')
    expect(result.chatId).toBeNull()
  })

  it('believes no worker on a URL without the key', async () => {
    const result = await call(`?${ASSISTANT_KEY_PARAM}=forged&${ASSISTANT_WORKER_PARAM}=w1&sessionId=42`)
    expect(result.worker).toBeNull()
    expect(result.chatId).toBe(42)
  })

  it('routes an OpenCode call by the session it names, not the shared URL, and strips the argument', async () => {
    bindOpencodeCaller('oc-session-9', assistantConversationId({ role: 'worker', id: 'w9' }))
    const result = await call(`?${assistantKeyQuery()}&${ASSISTANT_WORKER_PARAM}=w1`, { code: '1', [OPENCODE_CALLER_ARG]: 'oc-session-9' })
    expect(result.worker).toBe('w9')
    expect(result.body?.params.arguments).toEqual({ code: '1' })
  })

  it('refuses an OpenCode session the assistant never bound', async () => {
    const result = await call(`?${assistantKeyQuery()}`, { code: '1', [OPENCODE_CALLER_ARG]: 'oc-unknown' })
    expect(result.result?.isError).toBe(true)
  })
})
