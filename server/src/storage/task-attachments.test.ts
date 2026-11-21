import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'
import { sanitizeTaskAttachments, taskAttachmentFiles } from '../services/task-attachments.js'

// Run under Electron's Node to match the native SQLite ABI.
let storage: SqliteStorage
let projectId: number
beforeEach(() => {
  storage = new SqliteStorage(':memory:')
  projectId = storage.createProject({ name: 'Attachments', rootPath: '/tmp/attachments-test' }).id
})
afterEach(() => storage?.close())

const HASH = 'a'.repeat(64)
const image = { url: `/api/attachments/${HASH}`, mediaType: 'image/png', filename: 'shot.png' }

describe('task attachments', () => {
  it('stores description images on create and replaces them on update', () => {
    const task = storage.taskCreate({ projectId, title: 'With image', attachments: [image] })
    expect(storage.taskGet(task.id)?.attachments).toEqual([image])
    storage.taskUpdate(task.id, { attachments: [] })
    expect(storage.taskGet(task.id)?.attachments).toEqual([])
    expect(storage.taskCreate({ projectId, title: 'Plain' }).attachments).toEqual([])
  })

  it('keeps only stored images', () => {
    expect(sanitizeTaskAttachments([
      image,
      { url: 'https://example.com/x.png', mediaType: 'image/png' },
      { url: `/api/attachments/${HASH}`, mediaType: 'application/pdf' },
      { url: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
      null,
    ])).toEqual([image])
    expect(sanitizeTaskAttachments('nope')).toEqual([])
  })

  it('turns attachments into file parts for the agent', () => {
    expect(taskAttachmentFiles([image])).toEqual([{ type: 'file', ...image }])
  })
})

describe('task pull request summary', () => {
  it('carries the latest PR on the task row, following its state', () => {
    const task = storage.taskCreate({ projectId, title: 'With PR' })
    expect(storage.taskGet(task.id)?.pullRequest).toBeNull()
    storage.taskSurfaceUpsert({
      taskId: task.id, kind: 'github_pr', externalId: 'acme/app#12', url: 'https://github.com/acme/app/pull/12',
      meta: { repo: 'acme/app', number: 12, state: 'open', merged: false },
    })
    expect(storage.taskList({ projectId }).find((t) => t.id === task.id)?.pullRequest)
      .toEqual({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open' })
    storage.taskSurfaceUpsert({ taskId: task.id, kind: 'github_pr', externalId: 'acme/app#12', meta: { state: 'closed', merged: true } })
    expect(storage.taskGet(task.id)?.pullRequest?.state).toBe('merged')
  })
})
