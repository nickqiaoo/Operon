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
): Promise<{ chatId: number }> {
  const res = await ctx.request('/api/chat-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { chatId: number }
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
      messages: [msg('m1', 'user', 'hi there')],
      tp: 'chat',
      providerId: 'fake',
      model: 'fake-1',
    })
    expect(create.chatId).toBeGreaterThan(0)

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
      messages: [msg('m1', 'user', 'a')],
      tp: 'chat',
      workspaceId: ctx.workspaceId,
    })
    const b = await createChat(ctx, {
      messages: [msg('m1', 'user', 'b')],
      tp: 'canvas',
      workspaceId: ctx.workspaceId,
    })
    const c = await createChat(ctx, {
      messages: [msg('m1', 'user', 'c')],
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

  it('includes spec agent conversations only in their workspace history, with paging', async () => {
    const projectId = ctx.storage.getWorkspace(ctx.workspaceId)!.projectId
    const otherWorkspace = ctx.storage.createWorkspace(projectId, {
      name: 'Other Spec', branchName: 'operon/task-other', worktreePath: `${ctx.workspaceCwd}/other`,
    })
    const create = (title: string, tp: string, workspaceId = ctx.workspaceId) => createChat(ctx, {
      messages: [msg('m1', 'user', title)], tp, workspaceId, providerId: 'fake',
    })
    const discussion = await create('Discussion', 'chat')
    const agents = await Promise.all([
      create('explorer · Data and state', 'workflow-agent'),
      create('explorer · Flow and surfaces', 'workflow-agent'),
      create('explorer · Conventions and history', 'workflow-agent'),
    ])
    await create('Temporary side chat', 'side')
    await create('Another Spec explorer', 'workflow-agent', otherWorkspace.id)

    const list = async (query: string) => {
      const response = await ctx.request(`/api/chat-history${query}`)
      expect(response.status).toBe(200)
      return await response.json() as Array<{ id: number; tp: string; title: string; providerId?: string }>
    }
    const scoped = `?workspaceId=${ctx.workspaceId}`
    const expectedIds = [discussion.chatId, ...agents.map((agent) => agent.chatId)].sort((a, b) => a - b)
    const history = await list(scoped)
    expect(history.map((item) => item.id).sort((a, b) => a - b)).toEqual(expectedIds)
    expect(history.filter((item) => item.tp === 'workflow-agent')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: agents[0].chatId, title: 'explorer · Data and state', providerId: 'fake' }),
    ]))
    const pages = [...await list(`${scoped}&limit=2`), ...await list(`${scoped}&limit=2&offset=2`)]
    expect(pages.map((item) => item.id).sort((a, b) => a - b)).toEqual(expectedIds)
    expect((await list(`${scoped}&tp=chat`)).map((item) => item.id)).toEqual([discussion.chatId])
    expect((await list('')).map((item) => item.id)).toEqual([discussion.chatId])
  })

  it('rejects a message without an id with 400', async () => {
    const res = await ctx.request('/api/chat-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', parts: [] }] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/messages/)
  })

  it('rejects non-array messages with 400', async () => {
    const res = await ctx.request('/api/chat-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: 'nope' }),
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
      messages: [msg('m1', 'user', 'hello'), msg('m2', 'assistant', 'hi')],
      providerId: 'fake',
      model: 'fake-1',
    })

    const res = await ctx.request(`/api/chat-history/${chatId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: Array<{ role: string }>
      providerId?: string
      model?: string
    }
    expect(body.messages).toHaveLength(2)
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(body.providerId).toBe('fake')
    expect(body.model).toBe('fake-1')
  })

  it('returns paginated messages when limit is supplied', async () => {
    const { chatId } = await createChat(ctx, {
      messages: [
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

describe('DELETE /api/chat-history/:chatId', () => {
  let ctx: TestApp
  beforeEach(async () => { ctx = await makeTestApp() })
  afterEach(() => { ctx.cleanup() })

  it('removes an existing chat', async () => {
    const { chatId } = await createChat(ctx, {
      messages: [msg('m1', 'user', 'hi')],
    })

    const del = await ctx.request(`/api/chat-history/${chatId}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()) as { success: boolean }).toEqual({ success: true })

    const list = await ctx.request('/api/chat-history')
    const items = (await list.json()) as Array<{ id: number }>
    expect(items.some((item) => item.id === chatId)).toBe(false)
  })
})
