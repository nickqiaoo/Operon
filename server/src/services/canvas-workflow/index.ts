import type { CanvasRunTrigger, CanvasWorkflow } from '../../types/canvas-workflow.js'
import { runSubgraph, type NodeFailure } from './engine.js'
import { resolveWorkflowOutputs } from './outputs.js'
import type { CombinedStorage } from './types.js'

export { runSubgraph } from './engine.js'
export type { SubgraphResult, SubgraphRunOptions, NodeFailure } from './engine.js'
export type { CombinedStorage } from './types.js'
export { resolveWorkflowOutputs } from './outputs.js'

function describeFailures(failed: NodeFailure[]): string {
  const [first, ...rest] = failed
  const head = `Node "${first.name}" failed: ${first.error}`
  return rest.length > 0 ? `${head} (+${rest.length} more)` : head
}

export interface ExecuteWorkflowOptions {
  ancestorWorkflowIds?: Set<number>
  parentRunId?: number
}

/**
 * Execute a workflow as one run. A node failure marks the run as error once
 * everything that could still run has finished, so the result panel shows the
 * whole picture rather than the first crash.
 */
export async function executeCanvasWorkflow(
  workflow: CanvasWorkflow,
  runId: number,
  storage: CombinedStorage,
  options: ExecuteWorkflowOptions = {}
): Promise<Record<string, string>> {
  const topLevel = workflow.nodes.filter((node) => node.parentId === undefined)
  const result = await runSubgraph(topLevel, workflow.edges, {
    runId,
    workflowId: workflow.id,
    workspaceId: workflow.workspaceId,
    storage,
    ancestorWorkflowIds: options.ancestorWorkflowIds,
    workflow,
  })

  const outputs = resolveWorkflowOutputs(workflow, result)
  if (result.failed.length > 0) {
    storage.updateCanvasRunStatus(runId, 'error', { outputs, error: describeFailures(result.failed) })
  } else {
    storage.updateCanvasRunStatus(runId, 'success', { outputs })
  }
  return outputs
}

export interface StartExecutionOptions {
  trigger?: CanvasRunTrigger
}

export function startCanvasWorkflowExecution(
  storage: CombinedStorage,
  workflowId: number,
  options: StartExecutionOptions = {}
): { runId: number } {
  const workflow = storage.getCanvasWorkflow(workflowId)
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`)

  const runId = storage.createCanvasRun(workflowId, { trigger: options.trigger ?? 'manual' })

  // Run in background (fire-and-forget)
  executeCanvasWorkflow(workflow, runId, storage).catch((err) => {
    console.error(`[CanvasWorkflow] Execution failed: runId=${runId}`, err)
    storage.updateCanvasRunStatus(runId, 'error', { error: (err as Error).message })
  })

  return { runId }
}
