import { afterEach, beforeEach, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

let storage: SqliteStorage
let taskId: number
beforeEach(() => {
  storage = new SqliteStorage(':memory:')
  const project = storage.createProject({ name: 'Artifacts', rootPath: '/tmp/spec-artifacts' })
  taskId = storage.taskCreate({ projectId: project.id, title: 'Spec' }).id
})
afterEach(() => storage?.close())

it('starts empty and persists updates and deletions independently of workspace cleanup', () => {
  expect(storage.specArtifactsRead(taskId)).toEqual({})
  storage.specArtifactsWrite(taskId, { 'brief.md': 'Brief', 'design.md': 'Design', 'candidates/A.md': 'A' })
  storage.specArtifactsWrite(taskId, { 'design.md': 'Revised', 'candidates/A.md': null })
  storage.taskUpdate(taskId, { workspaceId: null, status: 'done' })
  expect(storage.specArtifactsRead(taskId)).toEqual({ 'brief.md': 'Brief', 'design.md': 'Revised' })
})

it('rolls back a document batch when one write fails', () => {
  storage.specArtifactsWrite(taskId, { 'design.md': 'Original' })
  expect(() => storage.specArtifactsWrite(taskId, { 'design.md': 'Changed', 'invalid.md': undefined as unknown as string })).toThrow()
  expect(storage.specArtifactsRead(taskId)).toEqual({ 'design.md': 'Original' })
  // A missing task violates the foreign key instead of leaving orphaned artifacts.
  expect(() => storage.specArtifactsWrite(taskId + 1000, { 'brief.md': 'Orphan' })).toThrow()
  expect(storage.specArtifactsRead(taskId + 1000)).toEqual({})
})
