import {
  MAX_LOOP_ITERATIONS,
  type CanvasLoopNodeData,
} from '../../../types/canvas-workflow.js'
import { evaluateCondition, parseOutputValue, renderTemplate, type Scope } from '../template.js'
import type { NodeExecutorDefinition } from '../types.js'
import { collectBody, reportProgress, runBodyOnce } from './group.js'
import { compileConditionGroup } from '../conditions.js'

/**
 * Dify's Loop: run the body until `until` holds or the round cap is hit.
 * Loop variables carry state across rounds; `next` templates are evaluated
 * against the finished body so a round can feed the next one.
 */
export const loopNode: NodeExecutorDefinition = {
  execute: async (ctx) => {
    const data = ctx.node.data as CanvasLoopNodeData
    const body = collectBody(ctx)
    const maxIterations = Math.max(1, Math.min(MAX_LOOP_ITERATIONS, data.maxIterations ?? 5))
    const variables = data.variables ?? []
    const exitExpression = compileConditionGroup({
      expression: data.until,
      conditions: data.untilConditions,
      combinator: data.untilCombinator,
    })

    const loopVars: Record<string, unknown> = {}
    for (const variable of variables) {
      if (!variable.name.trim()) continue
      loopVars[variable.name.trim()] = parseOutputValue(renderTemplate(variable.initial ?? '', ctx.scope))
    }

    let lastVariables: Scope = ctx.scope
    let exhausted = true
    let rounds = 0

    for (let index = 0; index < maxIterations; index++) {
      rounds = index + 1
      reportProgress(ctx, `round ${rounds}/${maxIterations}`)
      const loop = { ...loopVars, index }
      const scope = { ...ctx.scope, loop }
      const result = await runBodyOnce(ctx, body, scope, index, 'loop')
      if (result.failed.length > 0) {
        const first = result.failed[0]
        throw new Error(`loop failed in round ${rounds}: node "${first.name}": ${first.error}`)
      }

      lastVariables = { ...result.variables, loop }
      for (const variable of variables) {
        const name = variable.name.trim()
        if (!name || !variable.next?.trim()) continue
        loopVars[name] = parseOutputValue(renderTemplate(variable.next, lastVariables))
      }
      lastVariables = { ...lastVariables, loop: { ...loopVars, index } }

      let shouldExit: boolean
      try {
        shouldExit = exitExpression === 'false' ? false : evaluateCondition(exitExpression, lastVariables)
      } catch (error) {
        throw new Error(`loop failed: exit condition: ${(error as Error).message}`)
      }
      if (shouldExit) {
        exhausted = false
        break
      }
    }

    const output = renderTemplate(data.output ?? '', lastVariables)
    const value = parseOutputValue(output)
    const summary = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), iterations: rounds, exhausted }
      : { result: value, iterations: rounds, exhausted }
    return JSON.stringify(summary)
  },
}
