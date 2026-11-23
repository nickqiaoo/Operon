import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/task-events.js', () => ({ broadcastTask: vi.fn() }))
const startTaskTitleGeneration = vi.fn(async () => {})
vi.mock('../services/task-title.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/task-title.js')>()),
  startTaskTitleGeneration: (...args: unknown[]) => startTaskTitleGeneration(...(args as [])),
  isTaskTitlePending: () => false,
}))

import type { CreateTaskInput, Task } from '../types/task.js'
import { taskRoutes } from './task.js'

type Storage = Parameters<typeof taskRoutes>[0]

function routes() {
  const taskCreate = vi.fn((input: CreateTaskInput) => ({ id: 9, number: 4, ...input }) as unknown as Task)
  const taskDetail = vi.fn(() => ({ id: 9 }))
  const app = taskRoutes({ taskCreate, taskDetail } as unknown as Storage)
  const post = (body: unknown) =>
    app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { post, taskCreate }
}

describe('POST / (create a task)', () => {
  beforeEach(() => startTaskTitleGeneration.mockClear())

  it('keeps a title the person typed', async () => {
    const { post, taskCreate } = routes()
    const res = await post({ projectId: 1, title: '  Add divide ', description: 'Details' })
    expect(res.status).toBe(200)
    expect(taskCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Add divide', titleSource: 'user' }))
    expect(startTaskTitleGeneration).not.toHaveBeenCalled()
  })

  it('creates a task from its description alone, with a placeholder title it then generates', async () => {
    const { post, taskCreate } = routes()
    const res = await post({ projectId: 1, title: '  ', description: '## Fix the **login** page\n\nIt goes blank.' })
    expect(res.status).toBe(200)
    expect(taskCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fix the login page', titleSource: 'auto' }))
    expect(startTaskTitleGeneration).toHaveBeenCalledWith(expect.anything(), 9)
  })

  it('refuses a task with neither a title nor a description', async () => {
    const { post, taskCreate } = routes()
    expect((await post({ projectId: 1, title: '', description: '  ' })).status).toBe(400)
    expect((await post({ projectId: 1 })).status).toBe(400)
    // Images alone give nothing to title it from.
    const images = [{ url: '/api/attachments/abc', mediaType: 'image/png' }]
    expect((await post({ projectId: 1, attachments: images })).status).toBe(400)
    expect(taskCreate).not.toHaveBeenCalled()
  })

  it('still needs a project', async () => {
    const { post } = routes()
    expect((await post({ title: 'x' })).status).toBe(400)
  })
})
