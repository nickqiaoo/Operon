import type { CanvasEndNodeData } from '../../../types/canvas-workflow.js'
import type { NodeExecutorDefinition } from '../types.js'

/**
 * Declares the workflow's output shape. The run's `outputs` become this
 * node's rendered map instead of "whatever the leaves produced", which gives
 * webhook callers and parent workflows a stable contract.
 */
export const endNode: NodeExecutorDefinition = {
  execute: (ctx) => {
    const data = ctx.node.data as CanvasEndNodeData
    const outputs: Record<string, string> = {}
    for (const entry of data.outputs ?? []) {
      const key = entry.key.trim()
      if (!key) continue
      outputs[key] = ctx.render(entry.value ?? '')
    }
    return JSON.stringify(outputs)
  },
}
