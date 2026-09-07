import { IF_ELSE_HANDLE, type CanvasIfNodeData } from '../../../types/canvas-workflow.js'
import { evaluateCondition } from '../template.js'
import { compileConditionGroup } from '../conditions.js'
import type { NodeExecutorDefinition } from '../types.js'

/**
 * Multi-way branch. Cases are evaluated in order and the first truthy one
 * names the source handle the run continues through; none matching goes to
 * `else`. The node's output is the chosen handle id, which is mostly for the
 * result panel — downstream nodes read upstream variables directly.
 */
export const ifNode: NodeExecutorDefinition = {
  execute: (ctx) => {
    const data = ctx.node.data as CanvasIfNodeData
    for (const branch of data.cases ?? []) {
      let matched: boolean
      try {
        matched = evaluateCondition(compileConditionGroup(branch), ctx.scope)
      } catch (error) {
        throw new Error(`if failed: case "${branch.id}": ${(error as Error).message}`)
      }
      if (matched) return branch.id
    }
    return IF_ELSE_HANDLE
  },

  selectBranches: (output) => [output],
}
