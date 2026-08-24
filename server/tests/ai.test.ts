import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { makeTestApp, registerFakeScript, type TestApp } from './helpers/make-app.js'

async function readSseText(response: Response): Promise<string> {
  expect(response.body).toBeTruthy()
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
  }
  output += decoder.decode()
  return output
}

describe('/api/ai', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  describe('POST /chat', () => {
    it('streams text deltas from the fake runtime provider', async () => {
      registerFakeScript('hello', async function* () {
        yield { type: 'text-start', id: 'block-1' } as RuntimeStreamPart
        yield { type: 'text-delta', id: 'block-1', text: 'Hello ' } as RuntimeStreamPart
        yield { type: 'text-delta', id: 'block-1', text: 'world!' } as RuntimeStreamPart
        yield { type: 'text-end', id: 'block-1' } as RuntimeStreamPart
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        } as RuntimeStreamPart
      })

      const res = await ctx.request('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: 0,
          workspaceId: ctx.workspaceId,
          providerId: 'fake',
          modelId: 'fake-1',
          messages: [{
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: 'say hi' }],
          }],
          skipSnapshot: true,
        }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('x-chat-id')).toMatch(/^\d+$/)
      const chatId = Number(res.headers.get('x-chat-id'))
      expect(chatId).toBeGreaterThan(0)

      const body = await readSseText(res)
      expect(body).toContain('Hello ')
      expect(body).toContain('world!')
      expect(body).toContain('text-start')
      expect(body).toContain('finish')

      // Assistant message should have been persisted with the user + assistant turn.
      const list = await ctx.request(`/api/chat-history/${chatId}`)
      const full = (await list.json()) as { messages: Array<{ role: string }> }
      expect(full.messages.some((m) => m.role === 'user')).toBe(true)
      expect(full.messages.some((m) => m.role === 'assistant')).toBe(true)
    })

    it('returns a 500 error response when the runtime throws during setup', async () => {
      registerFakeScript('explode', async function* () {
        throw new Error('boom')
      })

      const res = await ctx.request('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: 0,
          // Intentionally omit workspaceId so resolveWorkspaceCwd throws.
          providerId: 'fake',
          modelId: 'fake-1',
          messages: [{
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: 'hi' }],
          }],
          skipSnapshot: true,
        }),
      })

      expect(res.status).toBe(500)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toContain('workspaceId')
    })
  })

  describe('POST /abort', () => {
    it('aborts an in-flight chat stream', async () => {
      const gate = { release: () => {} }
      const released = new Promise<void>((resolve) => {
        gate.release = resolve
      })

      registerFakeScript('slow', async function* () {
        yield { type: 'text-start', id: 'b1' } as RuntimeStreamPart
        yield { type: 'text-delta', id: 'b1', text: 'start...' } as RuntimeStreamPart
        await released
        yield { type: 'text-delta', id: 'b1', text: 'never sent' } as RuntimeStreamPart
        yield { type: 'text-end', id: 'b1' } as RuntimeStreamPart
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as RuntimeStreamPart
      })

      const chatPromise = ctx.request('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: 0,
          workspaceId: ctx.workspaceId,
          providerId: 'fake',
          modelId: 'fake-1',
          messages: [{
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: 'wait for it' }],
          }],
          skipSnapshot: true,
        }),
      })

      const res = await chatPromise
      expect(res.status).toBe(200)
      const chatId = Number(res.headers.get('x-chat-id'))
      expect(chatId).toBeGreaterThan(0)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Drain until we see the first delta, proving the stream is active.
      while (!buffer.includes('start...')) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
      expect(buffer).toContain('start...')

      const abortRes = await ctx.request('/api/ai/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId }),
      })
      expect(abortRes.status).toBe(200)
      expect((await abortRes.json()) as { success: boolean }).toEqual({ success: true })

      // Release the script so its generator can resume and hit the aborted check.
      gate.release()

      // Drain the stream fully; it should close without delivering the gated text.
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(buffer).not.toContain('never sent')
    })

    it('returns success=false when aborting a chat without an active session', async () => {
      const res = await ctx.request('/api/ai/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 424242 }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()) as { success: boolean }).toEqual({ success: false })
    })
  })

  describe('POST /session/cleanup', () => {
    it('returns success for an unknown chatId', async () => {
      const res = await ctx.request('/api/ai/session/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 99999 }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()) as { success: boolean }).toEqual({ success: true })
    })
  })

  describe('POST /permission-response', () => {
    it('returns success=false for an unknown chatId', async () => {
      const res = await ctx.request('/api/ai/permission-response', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unknown', outcome: 'allow', chatId: 77777 }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()) as { success: boolean }).toEqual({ success: false })
    })
  })

  describe('GET /checkpoints/:chatId', () => {
    it('returns an empty record for a fresh chat', async () => {
      const res = await ctx.request('/api/ai/checkpoints/12345')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { checkpoints: Record<string, unknown> }
      expect(body.checkpoints).toEqual({})
    })
  })

  describe('GET /providers', () => {
    it('includes the fake provider when enabled', async () => {
      const res = await ctx.request('/api/ai/providers')
      expect(res.status).toBe(200)
      const providers = (await res.json()) as Array<{ id: string }>
      expect(providers.some((p) => p.id === 'fake')).toBe(true)
    })
  })
})
