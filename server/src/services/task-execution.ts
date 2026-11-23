import type { TaskStorageAdapter } from '../storage/interface.js'
import type { Task } from '../types/task.js'
import { readRunView } from './workflow/store.js'
import { isTaskTitlePending } from './task-title.js'

/**
 * A task as the board shows it: with its title still being generated, and with
 * a Spec's design/review workflows counted as running (they run before, or
 * alongside, the Spec's task sessions).
 */
export function withTaskExecution<T extends Task | null>(storage: TaskStorageAdapter, input: T): T {
  const task = input && isTaskTitlePending(input.id) ? { ...input, titlePending: true } : input
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
