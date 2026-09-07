import type { CanvasInputNodeData } from '../../../types/canvas-workflow.js'
import type { NodeExecutorDefinition } from '../types.js'

/**
 * A constant text node. Kept for workflows saved before the Template node
 * existed; new workflows use Template (same thing, but it can also read
 * variables), so this type is no longer offered in the palette.
 */
export const inputNode: NodeExecutorDefinition = {
  execute: (ctx) => (ctx.node.data as CanvasInputNodeData).prompt,
}
