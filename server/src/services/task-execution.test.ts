import { describe, expect, it, vi } from 'vitest'
import type { TaskStorageAdapter } from '../storage/interface.js'
import type { Task } from '../types/task.js'

const workflow = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./workflow/store.js', () => ({ readRunView: workflow.read }))
import { withTaskExecution } from './task-execution.js'

const storage = { specRunGet: () => ({ workflowRunId: 'design-run' }) } as unknown as TaskStorageAdapter
const task = { id: 1, specStage: 'designing', executionStatus: 'idle' } as Task

describe('Spec workflow execution', () => {
  it('credits the provider that is actually working before task bindings exist', () => {
    workflow.read.mockReturnValue({ status: 'running', agents: [{ state: 'running', label: 'Candidate A', agentType: 'cursor', modelId: 'default' }] })
    expect(withTaskExecution(storage, task)).toMatchObject({ executionStatus: 'active', executionAgent: { provider: 'cursor', name: 'Candidate A' } })
  })

  it('does not animate queued agents or settled workflows', () => {
    workflow.read.mockReturnValue({ status: 'running', agents: [{ state: 'queued', agentType: 'codex' }] })
    expect(withTaskExecution(storage, task).executionStatus).toBe('idle')
    workflow.read.mockReturnValue({ status: 'completed', agents: [{ state: 'running', agentType: 'codex' }] })
    expect(withTaskExecution(storage, task).executionStatus).toBe('idle')
  })
})
