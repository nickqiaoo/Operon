import { describe, expect, it } from 'vitest'
import type { CanvasWorkflow } from '../types/canvas-workflow.js'
import type { CronjobTask, CronjobUpsertInput } from '../types/cronjob.js'
import { createCronjob, updateCronjob } from './cronjob.js'

type CronjobStorage = Parameters<typeof createCronjob>[0]

const schedule: CronjobUpsertInput['schedule'] = {
  type: 'daily',
  time: '09:00',
  days: [1, 2, 3, 4, 5],
}

const workflow: CanvasWorkflow = {
  id: 7,
  name: 'Workspace workflow',
  workspaceId: 22,
  nodes: [],
  edges: [],
  createdAt: 1,
  updatedAt: 1,
}

const workflowInput: CronjobUpsertInput = {
  name: 'Workflow schedule',
  enabled: true,
  taskType: 'canvas-workflow',
  canvasWorkflowId: workflow.id,
  workspaceId: 11,
  schedule,
}

function createStorage(current?: CronjobTask) {
  let saved: CronjobTask | undefined
  const storage = new Proxy({} as CronjobStorage, {
    get: (_target, property) => {
      if (property === 'getCanvasWorkflow') {
        return (id: number) => id === workflow.id ? workflow : null
      }
      if (property === 'getCronjobById') {
        return (id: number) => current?.id === id ? current : undefined
      }
      if (property === 'upsertCronjob') {
        return (job: CronjobTask) => {
          saved = job
        }
      }
      throw new Error(`Unexpected storage call: ${String(property)}`)
    },
  })

  return { storage, getSaved: () => saved }
}

describe('canvas workflow cronjob workspace ownership', () => {
  it('uses the selected workflow workspace when creating a schedule', () => {
    const { storage, getSaved } = createStorage()

    const job = createCronjob(storage, workflowInput)

    expect(job.workspaceId).toBe(workflow.workspaceId)
    expect(getSaved()?.workspaceId).toBe(workflow.workspaceId)
  })

  it('repairs a stale workspace when updating an existing schedule', () => {
    const current: CronjobTask = {
      id: 3,
      name: 'Old schedule',
      enabled: true,
      taskType: 'canvas-workflow',
      canvasWorkflowId: workflow.id,
      workspaceId: 11,
      providerId: '',
      prompt: '',
      schedule,
      createdAt: 1,
      updatedAt: 1,
    }
    const { storage, getSaved } = createStorage(current)

    const job = updateCronjob(storage, current.id, workflowInput)

    expect(job?.workspaceId).toBe(workflow.workspaceId)
    expect(getSaved()?.workspaceId).toBe(workflow.workspaceId)
  })

  it('rejects a schedule that references a missing workflow', () => {
    const { storage } = createStorage()

    expect(() => createCronjob(storage, {
      ...workflowInput,
      canvasWorkflowId: 999,
    })).toThrow('Canvas workflow not found: 999')
  })
})
