/**
 * OpenCLI-compatible `${{ ... }}` template renderer (subset).
 * Trusted adapter definitions only — expressions are not user-authored.
 */

export interface RenderContext {
  args?: Record<string, unknown>
  data?: unknown
  root?: unknown
  item?: unknown
  index?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function resolvePath(expr: string, scope: Record<string, unknown>): unknown {
  if (expr === "index") return scope.index
  if (expr === "args") return scope.args
  if (expr === "item") return scope.item
  if (expr === "data") return scope.data
  if (expr === "root") return scope.root

  const parts = expr.split(".")
  let current: unknown = scope
  for (const part of parts) {
    if (current == null) return undefined
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)]
      continue
    }
    if (!isRecord(current) && typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function applyFilter(filterExpr: string, value: unknown): unknown {
  const match = filterExpr.match(/^(\w+)(?:\((.+)\))?$/)
  if (!match) return value
  const name = match[1]!
  const rawArgs = match[2]
  const filterArg = rawArgs?.replace(/^['"]|['"]$/g, "") ?? ""

  switch (name) {
    case "default": {
      if (value === null || value === undefined || value === "") {
        const intVal = Number.parseInt(filterArg, 10)
        if (!Number.isNaN(intVal) && String(intVal) === filterArg.trim()) return intVal
        return filterArg
      }
      return value
    }
    case "json":
      return JSON.stringify(value ?? null)
    case "join":
      return Array.isArray(value) ? value.join(filterArg || ", ") : value
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value
    case "trim":
      return typeof value === "string" ? value.trim() : value
    case "length":
      return Array.isArray(value) ? value.length : typeof value === "string" ? value.length : value
    case "first":
      return Array.isArray(value) ? value[0] : value
    case "last":
      return Array.isArray(value) ? value[value.length - 1] : value
    case "urlencode":
      return typeof value === "string" ? encodeURIComponent(value) : value
    default:
      return value
  }
}

function evalJsExpr(expr: string, scope: Record<string, unknown>): unknown {
  const sandbox: Record<string, unknown> = {
    Math,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    ...scope,
  }
  const keys = Object.keys(sandbox)
  const values = keys.map((k) => sandbox[k])
  // Adapter definitions are trusted app code (not model/user strings).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...keys, `"use strict"; return (${expr});`)
  return fn(...values)
}

export function evalExpr(expr: string, ctx: RenderContext): unknown {
  const args = ctx.args ?? {}
  const item = ctx.item ?? {}
  const data = ctx.data
  const root = ctx.root
  const index = ctx.index ?? 0
  const scope: Record<string, unknown> = { args, item, data, root, index }

  const pipeSegments = expr.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim())
  if (pipeSegments.length > 1) {
    let result = evalExpr(pipeSegments[0]!, ctx)
    for (let i = 1; i < pipeSegments.length; i++) {
      result = applyFilter(pipeSegments[i]!, result)
    }
    return result
  }

  const strLit = expr.match(/^(['"])(.*)\1$/)
  if (strLit) return strLit[2]

  if (/^\d+(\.\d+)?$/.test(expr)) return Number(expr)

  if (/^[A-Za-z_$][\w.$]*$/.test(expr)) {
    const resolved = resolvePath(expr, scope)
    if (resolved !== undefined) return resolved
  }

  try {
    return evalJsExpr(expr, scope)
  } catch (error) {
    throw new Error(
      `template expr failed: ${expr} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

export function render(template: unknown, ctx: RenderContext): unknown {
  if (typeof template !== "string") return template
  const trimmed = template.trim()
  const single = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/)
  if (single && !single[1]!.includes("${{")) {
    return evalExpr(single[1]!.trim(), ctx)
  }
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_m, expr: string) =>
    String(evalExpr(expr.trim(), ctx)),
  )
}
