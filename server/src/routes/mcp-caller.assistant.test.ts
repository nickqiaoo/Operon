import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSISTANT_CALLER_ARG, ASSISTANT_KEY_PARAM, assistantNodeReplQuery, isAssistantMountKey } from '../services/assistant/node-repl-bridge.js'
import { resolveMcpCallerChat, takeAssistantWorkerArg } from './mcp-caller.js'

describe('takeAssistantWorkerArg', () => {
  it('reads the worker and strips the argument before any tool sees it', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1+1', [ASSISTANT_CALLER_ARG]: 'worker-ab12' } } }
    expect(takeAssistantWorkerArg(body)).toBe('worker-ab12')
    expect(body.params.arguments).toEqual({ code: '1+1' })
  })

  it('ignores calls without it and rejects ids that could escape the key', () => {
    expect(takeAssistantWorkerArg({ method: 'tools/call', params: { arguments: { code: 'x' } } })).toBeUndefined()
    const bad = { method: 'tools/call', params: { arguments: { [ASSISTANT_CALLER_ARG]: '../../etc' } } }
    expect(takeAssistantWorkerArg(bad)).toBeUndefined()
    expect(bad.params.arguments).toEqual({})
  })
})

describe('isAssistantMountKey', () => {
  it("accepts only this process's key", () => {
    const key = new URLSearchParams(assistantNodeReplQuery()).get(ASSISTANT_KEY_PARAM) ?? ''
    expect(isAssistantMountKey(key)).toBe(true)
    expect(isAssistantMountKey(undefined)).toBe(false)
    expect(isAssistantMountKey('')).toBe(false)
    expect(isAssistantMountKey(`${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`)).toBe(false)
    expect(isAssistantMountKey(key.slice(1))).toBe(false)
  })
})

describe('resolveMcpCallerChat and the assistant worker argument', () => {
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

  const call = async (query: string) => {
    const response = await fetch(`${base}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1', [ASSISTANT_CALLER_ARG]: 'w1' } } }),
    })
    return (await response.json()) as { chatId: number | null; worker: string | null; body: { params: { arguments: Record<string, unknown> } } }
  }

  it("routes to the worker on the assistant's own mount", async () => {
    const result = await call(`?${assistantNodeReplQuery()}`)
    expect(result.worker).toBe('w1')
    expect(result.chatId).toBeNull()
    expect(result.body.params.arguments).toEqual({ code: '1' })
  })

  it('ignores a worker named on any other request, and still strips it', async () => {
    const result = await call('?sessionId=42')
    expect(result.worker).toBeNull()
    expect(result.chatId).toBe(42)
    expect(result.body.params.arguments).toEqual({ code: '1' })
    expect((await call(`?${ASSISTANT_KEY_PARAM}=forged&sessionId=42`)).worker).toBeNull()
  })
})
