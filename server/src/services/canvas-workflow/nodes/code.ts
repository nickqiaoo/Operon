import vm from 'node:vm'
import type { CanvasCodeNodeData, CanvasNode } from '../../../types/canvas-workflow.js'
import type { NodeExecutorDefinition } from '../types.js'

const DEFAULT_CODE_TIMEOUT_MS = 10_000

/**
 * Run a JavaScript function body against the template scope. This is a
 * data-shaping node (filter, aggregate, extract), so the context deliberately
 * has no `require`, no filesystem and no network — a workflow that needs those
 * reaches for the shell / http / AI nodes, which are visible as such on the
 * canvas.
 */
export const codeNode: NodeExecutorDefinition = {
  timeoutMs: (node: CanvasNode) =>
    (node.data as CanvasCodeNodeData).timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,

  execute: async (ctx) => {
    const data = ctx.node.data as CanvasCodeNodeData
    const body = data.code ?? ''
    if (body.trim().length === 0) throw new Error('code failed: function body is empty')

    const logs: string[] = []
    const context = vm.createContext({
      inputs: ctx.scope,
      console: {
        log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
        error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
      },
    })

    let result: unknown
    try {
      const script = new vm.Script(`(function (inputs) {\n${body}\n})(inputs)`, {
        filename: `canvas-code-${ctx.nodeId}.js`,
      })
      const timeoutMs = codeNode.timeoutMs!(ctx.node)
      result = script.runInContext(context, { timeout: timeoutMs })
      if (result !== null && typeof result === 'object' && 'then' in result && typeof (result as PromiseLike<unknown>).then === 'function') {
        result = await (result as PromiseLike<unknown>)
      }
    } catch (error) {
      const message = (error as Error).message
      const trail = logs.length > 0 ? `\n[console]\n${logs.join('\n')}` : ''
      throw new Error(`code failed: ${message}${trail}`)
    }

    if (result === undefined || result === null) return ''
    if (typeof result === 'string') return result
    return JSON.stringify(result)
  },
}
