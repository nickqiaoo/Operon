import type { CanvasTemplateNodeData } from '../../../types/canvas-workflow.js'
import type { NodeExecutorDefinition } from '../types.js'

/** A text node that can see upstream variables: joins, formats, aggregates. */
export const templateNode: NodeExecutorDefinition = {
  execute: (ctx) => {
    const data = ctx.node.data as CanvasTemplateNodeData
    return ctx.render(data.template ?? '')
  },
}
