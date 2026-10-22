import type { TaskStorageAdapter } from '../storage/interface.js'
import type { Task } from '../types/task.js'
import { readRunView } from './workflow/store.js'

/** Design/review workflows run before (or alongside) the Spec's task sessions. */
export function withTaskExecution<T extends Task | null>(storage: TaskStorageAdapter, task: T): T {
  if (!task || task.specStage == null || task.executionStatus === 'active') return task
  const run = storage.specRunGet(task.id)
  const workflow = run?.workflowRunId ? readRunView(run.workflowRunId) : undefined
  const agent = workflow?.status === 'running' ? workflow.agents.find((a) => a.state === 'running' && a.agentType) : undefined
  if (!agent?.agentType) return task
  return {
    ...task,
    executionStatus: 'active',
    executionAgent: { id: -1, name: agent.label, provider: agent.agentType, model: agent.modelId ?? '' },
  }
}
