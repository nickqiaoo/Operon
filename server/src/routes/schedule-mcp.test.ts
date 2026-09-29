import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CronjobTask } from '../types/cronjob.js'
import type { ChatMeta } from '../types/chat.js'
import { buildScheduleMcpServer, type ScheduleMcpStorage } from './schedule-mcp.js'

const svc = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), del: vi.fn(), exec: vi.fn(), history: vi.fn(),
}))
vi.mock('../services/cronjob.js', () => ({
  listCronjobs: svc.list, getCronjob: svc.get, createCronjob: svc.create, updateCronjob: svc.update,
  deleteCronjob: svc.del, executeCronjob: svc.exec, getCronjobExecutionHistory: svc.history,
}))
vi.mock('../services/ai/providers.js', () => ({
  getProviders: () => [
    { id: 'claude-code', label: 'Claude', available: true },
    { id: 'codex', label: 'Codex', available: true },
    { id: 'kimi', label: 'Kimi', available: false },
  ],
}))

const job = (over: Partial<CronjobTask> = {}): CronjobTask => ({
  id: 7, name: 'Digest', enabled: true, taskType: 'chat', providerId: 'claude-code', modelId: 'opus',
  prompt: 'Summarize PRs', schedule: { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
  workspaceId: 3, createdAt: 0, updatedAt: 0, ...over,
})

const callerMeta: ChatMeta = { revision: 1, tp: 'chat', providerId: 'claude-code', model: 'opus', workspaceId: 3, thinkingLevel: 'high', updatedAt: 0 }

async function connect(meta: ChatMeta | undefined) {
  const storage = { getChatMeta: () => meta } as unknown as ScheduleMcpStorage
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'schedule-test', version: '1' })
  await buildScheduleMcpServer(storage, 42).connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ text: string }>)[0].text

describe('Schedule MCP', () => {
  let client: Client
  beforeEach(async () => {
    vi.clearAllMocks()
    client = await connect(callerMeta)
  })
  afterEach(async () => { await client.close() })

  it('creates a task with the calling conversation as defaults', async () => {
    svc.create.mockImplementation((_s, input) => job({ ...input, id: 9 }))
    const result = await client.callTool({ name: 'schedule_create', arguments: {
      name: 'Digest', prompt: 'Summarize PRs', schedule: { time: '09:00', days: [1, 2, 3, 4, 5] },
    } })
    expect(result.isError).toBeFalsy()
    expect(svc.create.mock.calls[0][1]).toMatchObject({
      taskType: 'chat', providerId: 'claude-code', modelId: 'opus', thinkingLevel: 'high', workspaceId: 3, enabled: true,
    })
    expect(textOf(result)).toContain('"when":"09:00, Mon,Tue,Wed,Thu,Fri"')
  })

  it('drops the caller model when another agent is chosen, and rejects unavailable agents', async () => {
    svc.create.mockImplementation((_s, input) => job(input))
    await client.callTool({ name: 'schedule_create', arguments: { name: 'x', prompt: 'p', provider_id: 'codex', schedule: { time: '08:00' } } })
    expect(svc.create.mock.calls[0][1]).toMatchObject({ providerId: 'codex', modelId: undefined, thinkingLevel: undefined })
    const bad = await client.callTool({ name: 'schedule_create', arguments: { name: 'x', prompt: 'p', provider_id: 'kimi', schedule: { time: '08:00' } } })
    expect(bad.isError).toBe(true)
    expect(svc.create).toHaveBeenCalledTimes(1)
  })

  it('updates only the given fields', async () => {
    svc.get.mockReturnValue(job())
    svc.update.mockImplementation((_s, _id, input) => job(input))
    await client.callTool({ name: 'schedule_update', arguments: { id: 7, enabled: false } })
    expect(svc.update.mock.calls[0][2]).toMatchObject({
      name: 'Digest', enabled: false, providerId: 'claude-code', modelId: 'opus', prompt: 'Summarize PRs', workspaceId: 3,
      schedule: { time: '09:00', days: [1, 2, 3, 4, 5] },
    })
  })

  it('starts a run without waiting for it', async () => {
    svc.get.mockReturnValue(job())
    svc.exec.mockReturnValue(new Promise(() => {}))
    const result = await client.callTool({ name: 'schedule_run_now', arguments: { id: 7 } })
    expect(result.isError).toBeFalsy()
    expect(svc.exec).toHaveBeenCalledOnce()
  })

  it('lets a scheduled run read but not change tasks', async () => {
    await client.close()
    client = await connect({ ...callerMeta, tp: 'cronjob' })
    svc.list.mockReturnValue([job()])
    expect((await client.callTool({ name: 'schedule_list', arguments: {} })).isError).toBeFalsy()
    const created = await client.callTool({ name: 'schedule_create', arguments: { name: 'x', prompt: 'p', schedule: { time: '08:00' } } })
    expect(created.isError).toBe(true)
    expect(svc.create).not.toHaveBeenCalled()
  })
})
