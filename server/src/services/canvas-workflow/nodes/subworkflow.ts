import {
  MAX_SUBWORKFLOW_DEPTH,
  type CanvasSubWorkflowNodeData,
} from '../../../types/canvas-workflow.js'
import { runSubgraph } from '../engine.js'
import { resolveWorkflowOutputs } from '../outputs.js'
import { parseOutputValue, type Scope } from '../template.js'
import type { NodeExecutorDefinition } from '../types.js'

/**
 * Call another workflow as a node. The child runs as its own child run with
 * the given Input overrides; its End outputs (or leaves) become this node's
 * output. The ancestor set stops A → B → A at run time; the save-time check
 * in the route catches it earlier.
 */
export const subWorkflowNode: NodeExecutorDefinition = {
  execute: async (ctx) => {
    const data = ctx.node.data as CanvasSubWorkflowNodeData
    const child = ctx.storage.getCanvasWorkflow(data.workflowId)
    if (!child) throw new Error(`subworkflow failed: workflow ${data.workflowId} not found`)

    const ancestors = new Set(ctx.options.ancestorWorkflowIds ?? [])
    ancestors.add(ctx.workflowId)
    if (ancestors.has(child.id)) {
      throw new Error(`subworkflow failed: "${child.name}" is already running up the call chain (cycle)`)
    }
    if (ancestors.size >= MAX_SUBWORKFLOW_DEPTH) {
      throw new Error(`subworkflow failed: nesting deeper than ${MAX_SUBWORKFLOW_DEPTH} workflows`)
    }

    // Variables for the child: the caller decides the names, the child's
    // templates read them like any other variable. Nothing inside the child
    // has to declare them first.
    const injected: Scope = {}
    for (const entry of data.inputs ?? []) {
      const name = entry.key.trim()
      if (!name) continue
      injected[name] = parseOutputValue(ctx.render(entry.value ?? ''))
    }

    const childRunId = ctx.storage.createCanvasRun(child.id, { parentRunId: ctx.runId, trigger: 'subworkflow' })
    const topLevel = child.nodes.filter((node) => node.parentId === undefined)
    let result
    try {
      result = await runSubgraph(topLevel, child.edges, {
        runId: childRunId,
        workflowId: child.id,
        workspaceId: child.workspaceId ?? ctx.workspaceId,
        storage: ctx.storage,
        scope: injected,
        ancestorWorkflowIds: ancestors,
        workflow: child,
      })
    } catch (error) {
      ctx.storage.updateCanvasRunStatus(childRunId, 'error', { error: (error as Error).message })
      throw error
    }

    const outputs = resolveWorkflowOutputs(child, result)
    if (result.failed.length > 0) {
      const first = result.failed[0]
      ctx.storage.updateCanvasRunStatus(childRunId, 'error', { outputs, error: `Node "${first.name}" failed: ${first.error}` })
      throw new Error(`subworkflow failed: "${child.name}" node "${first.name}": ${first.error}`)
    }
    ctx.storage.updateCanvasRunStatus(childRunId, 'success', { outputs })
    return JSON.stringify(outputs)
  },
}
