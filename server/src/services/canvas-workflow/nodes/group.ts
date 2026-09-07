import type { CanvasEdge, CanvasNode, CanvasRunTrigger } from '../../../types/canvas-workflow.js'
import { runSubgraph, type SubgraphResult } from '../engine.js'
import type { Scope } from '../template.js'
import type { NodeExecutionContext } from '../types.js'

/** The nodes and edges drawn inside a group node. */
export function collectBody(ctx: NodeExecutionContext): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const workflow = ctx.options.workflow
  if (!workflow) throw new Error(`${ctx.node.type} failed: group nodes need the whole workflow to find their body`)
  const nodes = workflow.nodes.filter((node) => node.parentId === ctx.nodeId)
  const ids = new Set(nodes.map((node) => node.id))
  const edges = workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  return { nodes, edges }
}

/**
 * Run the body once as its own child run. The top-level run mirrors the
 * body's node results so the canvas shows the round in progress; the child
 * run keeps that round in history after the next one overwrites the mirror.
 */
export async function runBodyOnce(
  ctx: NodeExecutionContext,
  body: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  scope: Scope,
  iteration: number,
  trigger: CanvasRunTrigger
): Promise<SubgraphResult> {
  const childRunId = ctx.storage.createCanvasRun(ctx.workflowId, {
    parentRunId: ctx.runId,
    iteration,
    trigger,
  })

  let result: SubgraphResult
  try {
    result = await runSubgraph(body.nodes, body.edges, {
      ...ctx.options,
      runId: childRunId,
      mirrorRunId: ctx.runId,
      scope,
      iteration,
      recordNodeResults: true,
    })
  } catch (error) {
    ctx.storage.updateCanvasRunStatus(childRunId, 'error', { error: (error as Error).message })
    throw error
  }

  if (result.failed.length > 0) {
    const first = result.failed[0]
    ctx.storage.updateCanvasRunStatus(childRunId, 'error', {
      outputs: result.outputs,
      error: `Node "${first.name}" failed: ${first.error}`,
    })
  } else {
    ctx.storage.updateCanvasRunStatus(childRunId, 'success', { outputs: result.outputs })
  }
  return result
}

/** Show progress on the group node itself while it runs. */
export function reportProgress(ctx: NodeExecutionContext, text: string): void {
  ctx.storage.updateCanvasNodeResult(ctx.runId, ctx.nodeId, { status: 'running', output: text })
}
