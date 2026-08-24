import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

type UiMessage = { id: string; role: string; parts: Array<{ type: string; text: string }> }
const msg = (id: string, role: 'user' | 'assistant', text: string): UiMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

async function createChat(
  ctx: TestApp,
  body: Record<string, unknown>,
): Promise<{ chatId: number; revision: number }> {
  const res = await ctx.request('/api/chat-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { chatId: number; revision: number }
}

describe('POST /api/chat-history', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('creates a chat and lists it', async () => {
    const create = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hi there')],
      tp: 'chat',
      providerId: 'fake',
      model: 'fake-1',
    })
    expect(create.chatId).toBeGreaterThan(0)
    expect(create.revision).toBe(1)

    const list = await ctx.request('/api/chat-history')
    expect(list.status).toBe(200)
    const items = (await list.json()) as Array<{ id: number; tp: string; title: string }>
    const found = items.find((item) => item.id === create.chatId)
    expect(found).toBeTruthy()
    expect(found?.tp).toBe('chat')
    expect(found?.title).toBe('hi there')
  })

  it('filters list by workspaceId and tp', async () => {
    const a = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'a')],
      tp: 'chat',
      workspaceId: ctx.workspaceId,
    })
    const b = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'b')],
      tp: 'canvas',
      workspaceId: ctx.workspaceId,
    })
    const c = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'c')],
      tp: 'chat',
      workspaceId: 9999,
    })

    const filtered = await ctx.request(
      `/api/chat-history?workspaceId=${ctx.workspaceId}&tp=chat`,
    )
    const items = (await filtered.json()) as Array<{ id: number }>
    const ids = items.map((item) => item.id)
    expect(ids).toContain(a.chatId)
    expect(ids).not.toContain(b.chatId)
    expect(ids).not.toContain(c.chatId)
  })

  it('rejects negative baseRevision with 400', async () => {
    const res = await ctx.request('/api/chat-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: -1, replaceFrom: 0, tailMessages: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/baseRevision/)
  })

  it('rejects non-array tailMessages with 400', async () => {
    const res = await ctx.request('/api/chat-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: 0, replaceFrom: 0, tailMessages: 'nope' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/chat-history/:chatId', () => {
  let ctx: TestApp
  beforeEach(async () => { ctx = await makeTestApp() })
  afterEach(() => { ctx.cleanup() })

  it('returns the full chat payload with messages and metadata', async () => {
    const { chatId } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hello'), msg('m2', 'assistant', 'hi')],
      providerId: 'fake',
      model: 'fake-1',
    })

    const res = await ctx.request(`/api/chat-history/${chatId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: Array<{ role: string }>
      providerId?: string
      model?: string
      revision: number
    }
    expect(body.messages).toHaveLength(2)
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(body.providerId).toBe('fake')
    expect(body.model).toBe('fake-1')
    expect(body.revision).toBe(1)
  })

  it('returns paginated messages when limit is supplied', async () => {
    const { chatId } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [
        msg('m1', 'user', 'one'),
        msg('m2', 'assistant', 'two'),
        msg('m3', 'user', 'three'),
      ],
    })

    const res = await ctx.request(`/api/chat-history/${chatId}?limit=2`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: unknown[]
      total: number
      hasMore: boolean
      nextCursor?: number
    }
    expect(body.messages).toHaveLength(2)
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(true)
    expect(body.nextCursor).toBeDefined()
  })
})

describe('PATCH /api/chat-history/:chatId', () => {
  let ctx: TestApp
  beforeEach(async () => { ctx = await makeTestApp() })
  afterEach(() => { ctx.cleanup() })

  it('appends messages and bumps revision when baseRevision matches', async () => {
    const { chatId, revision } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hi')],
    })

    const res = await ctx.request(`/api/chat-history/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        replaceFrom: 1,
        tailMessages: [msg('m2', 'assistant', 'hello back')],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; chatId: number; revision: number }
    expect(body.success).toBe(true)
    expect(body.chatId).toBe(chatId)
    expect(body.revision).toBe(revision + 1)

    const full = await ctx.request(`/api/chat-history/${chatId}`)
    const payload = (await full.json()) as { messages: Array<{ id: string }> }
    expect(payload.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('reports conflict with the current revision when baseRevision is stale', async () => {
    const { chatId, revision } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hi')],
    })

    // First writer wins.
    const first = await ctx.request(`/api/chat-history/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        replaceFrom: 1,
        tailMessages: [msg('m2', 'assistant', 'winner')],
      }),
    })
    const firstBody = (await first.json()) as { success: boolean; revision: number }
    expect(firstBody.success).toBe(true)

    // Second writer uses the stale revision.
    const stale = await ctx.request(`/api/chat-history/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        replaceFrom: 1,
        tailMessages: [msg('m3', 'assistant', 'loser')],
      }),
    })
    expect(stale.status).toBe(200)
    const body = (await stale.json()) as { success: boolean; conflict: boolean; revision: number }
    expect(body.success).toBe(false)
    expect(body.conflict).toBe(true)
    expect(body.revision).toBe(firstBody.revision)

    const full = await ctx.request(`/api/chat-history/${chatId}`)
    const payload = (await full.json()) as { messages: Array<{ id: string }> }
    expect(payload.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('reports conflict when replaceFrom exceeds message count', async () => {
    const { chatId, revision } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hi')],
    })

    const res = await ctx.request(`/api/chat-history/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        replaceFrom: 99,
        tailMessages: [msg('m2', 'assistant', 'oob')],
      }),
    })
    const body = (await res.json()) as { success: boolean; conflict: boolean }
    expect(body.success).toBe(false)
    expect(body.conflict).toBe(true)
  })

  it('replaces the tail starting at replaceFrom', async () => {
    const { chatId, revision } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [
        msg('m1', 'user', 'one'),
        msg('m2', 'assistant', 'two'),
        msg('m3', 'user', 'three'),
      ],
    })

    const res = await ctx.request(`/api/chat-history/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        replaceFrom: 1,
        tailMessages: [msg('m2x', 'assistant', 'rewritten')],
      }),
    })
    const body = (await res.json()) as { success: boolean; revision: number }
    expect(body.success).toBe(true)

    const full = await ctx.request(`/api/chat-history/${chatId}`)
    const payload = (await full.json()) as { messages: Array<{ id: string }> }
    expect(payload.messages.map((m) => m.id)).toEqual(['m1', 'm2x'])
  })
})

describe('DELETE /api/chat-history/:chatId', () => {
  let ctx: TestApp
  beforeEach(async () => { ctx = await makeTestApp() })
  afterEach(() => { ctx.cleanup() })

  it('removes an existing chat', async () => {
    const { chatId } = await createChat(ctx, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [msg('m1', 'user', 'hi')],
    })

    const del = await ctx.request(`/api/chat-history/${chatId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()) as { success: boolean }).toEqual({ success: true })

    const list = await ctx.request('/api/chat-history')
    const items = (await list.json()) as Array<{ id: number }>
    expect(items.some((item) => item.id === chatId)).toBe(false)
  })
})
