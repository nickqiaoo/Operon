import type { CanvasWorkflow } from '../../types/canvas-workflow.js'
import type { SubgraphResult } from './engine.js'

/**
 * A workflow's outputs: what its End nodes declared (merged, when several
 * branches each end), else the leaf outputs — the shape older workflows
 * without an End node have always had.
 */
export function resolveWorkflowOutputs(workflow: CanvasWorkflow, result: SubgraphResult): Record<string, string> {
  const endNodes = workflow.nodes.filter((node) => node.type === 'end')
  if (endNodes.length === 0) return result.outputs

  const merged: Record<string, string> = {}
  let sawEnd = false
  for (const node of endNodes) {
    const raw = result.nodeOutputs.get(node.id)
    if (raw === undefined) continue
    sawEnd = true
    try {
      Object.assign(merged, JSON.parse(raw) as Record<string, string>)
    } catch {
      // An End node always writes JSON; a parse failure means the output was
      // truncated, in which case there is nothing sensible to merge.
    }
  }
  return sawEnd ? merged : result.outputs
}
