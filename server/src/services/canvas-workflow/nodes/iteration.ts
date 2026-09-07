import {
  MAX_ITERATION_CONCURRENCY,
  type CanvasIterationNodeData,
} from '../../../types/canvas-workflow.js'
import { parseOutputValue, renderTemplate } from '../template.js'
import type { NodeExecutorDefinition } from '../types.js'
import { collectBody, reportProgress, runBodyOnce } from './group.js'

function parseItems(rendered: string, mode: CanvasIterationNodeData['sourceMode']): unknown[] {
  if (mode === 'lines') {
    return rendered.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  }
  const value = parseOutputValue(rendered)
  if (!Array.isArray(value)) throw new Error('iteration failed: source did not render to a JSON array')
  return value
}

/**
 * Dify's Iteration: run the group body once per item, in parallel up to
 * `concurrency`, and collect each round's `output` into a JSON array.
 */
export const iterationNode: NodeExecutorDefinition = {
  execute: async (ctx) => {
    const data = ctx.node.data as CanvasIterationNodeData
    const body = collectBody(ctx)
    const items = parseItems(ctx.render(data.source ?? ''), data.sourceMode ?? 'json')
    const concurrency = Math.max(1, Math.min(MAX_ITERATION_CONCURRENCY, data.concurrency ?? 4))
    const results: string[] = new Array(items.length)
    let done = 0
    let cursor = 0

    reportProgress(ctx, `0/${items.length} done`)

    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor++
        const scope = { ...ctx.scope, item: items[index], index }
        const result = await runBodyOnce(ctx, body, scope, index, 'iteration')
        if (result.failed.length > 0) {
          const first = result.failed[0]
          throw new Error(`iteration failed at item ${index}: node "${first.name}": ${first.error}`)
        }
        results[index] = renderTemplate(data.output ?? '', { ...result.variables, item: items[index], index })
        done += 1
        reportProgress(ctx, `${done}/${items.length} done`)
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
    return JSON.stringify(results.map((text) => parseOutputValue(text)))
  },
}
