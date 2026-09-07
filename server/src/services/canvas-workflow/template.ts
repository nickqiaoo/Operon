import nunjucks from 'nunjucks'
import type { CanvasNode } from '../../types/canvas-workflow.js'
import { getEnvVars } from '../env-config.js'

/**
 * Variables visible to a node's templates. Keys are node names (sanitized to
 * identifiers), values are the node's output — parsed into an object/array
 * when the output is JSON, otherwise the raw string. `env` carries the user's
 * configured environment variables so secrets can be referenced as
 * `{{ env.GITHUB_TOKEN }}` instead of being pasted into the workflow.
 */
export type Scope = Record<string, unknown>

const templateEnv = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
})

templateEnv.addFilter('tojson', (value: unknown, indent?: number) =>
  JSON.stringify(value, null, indent)
)

templateEnv.addFilter('lines', (value: unknown) => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
})

templateEnv.addFilter('regex_test', (value: unknown, pattern: string, flags?: string) => {
  try {
    return new RegExp(pattern, flags).test(typeof value === 'string' ? value : String(value ?? ''))
  } catch {
    return false
  }
})

/**
 * Compile without rendering, to catch syntax errors at save time. Returns
 * the parser's message, trimmed of nunjucks' "(unknown path)" prefix.
 */
export function checkTemplateSyntax(source: string, kind: 'template' | 'condition' = 'template'): string | null {
  const text = kind === 'condition' ? `{{ 'true' if (${source.trim()}) else 'false' }}` : source
  try {
    // eslint-disable-next-line no-new
    new nunjucks.Template(text, templateEnv, undefined, true)
    return null
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    return message.replace(/^\(unknown path\)\s*/m, '').replace(/^Template render error:\s*/m, '').trim().split('\n')[0]
  }
}

export function renderTemplate(template: string, scope: Scope): string {
  return templateEnv.renderString(template, scope)
}

/**
 * Evaluate a bare nunjucks expression (no `{{ }}`) and report whether it is
 * truthy. Used by IF/ELSE and loop exit conditions. Throws on render errors so
 * a typo never silently falls through to the else branch.
 */
export function evaluateCondition(expression: string, scope: Scope): boolean {
  const trimmed = expression.trim()
  if (trimmed.length === 0) throw new Error('condition expression is empty')
  const rendered = templateEnv.renderString(`{{ 'true' if (${trimmed}) else 'false' }}`, scope).trim()
  return rendered === 'true'
}

// ---- Node-name → identifier mapping ----

export function getNodeName(node: CanvasNode | undefined, fallbackId: string): string {
  if (!node) return fallbackId
  const name = node.name.trim()
  return name.length > 0 ? name : fallbackId
}

function sanitizeTemplateKey(rawName: string): string {
  const normalized = rawName.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (normalized.length === 0) return 'node'
  return /^[0-9]/.test(normalized) ? `node_${normalized}` : normalized
}

function isTemplateIdentifier(rawName: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName)
}

/** The identifier a node's output is published under in templates. */
export function templateKeyForNode(node: CanvasNode | undefined, fallbackId: string): string {
  const name = getNodeName(node, fallbackId)
  return isTemplateIdentifier(name) ? name : sanitizeTemplateKey(name)
}

function setUniqueAlias(scope: Scope, baseKey: string, value: unknown): void {
  if (!(baseKey in scope)) {
    scope[baseKey] = value
    return
  }
  let suffix = 2
  let candidate = `${baseKey}_${suffix}`
  while (candidate in scope) {
    suffix += 1
    candidate = `${baseKey}_${suffix}`
  }
  scope[candidate] = value
}

// ---- Output → value ----

/**
 * Make parsed JSON render sensibly when a template interpolates the whole
 * value (`{{ review }}`): nunjucks would print `[object Object]`. A
 * non-enumerable toString keeps `tojson`, JSON.stringify and Object.keys
 * unaffected.
 */
function attachJsonToString(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  Object.defineProperty(value, 'toString', {
    value: function toString(this: unknown) { return JSON.stringify(this) },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const child of children) attachJsonToString(child)
}

/**
 * Objects and arrays come through as data; everything else stays a string so
 * `"123"` and `"true"` keep rendering exactly as the node produced them.
 */
export function parseOutputValue(output: string): unknown {
  const trimmed = output.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return output
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') {
      attachJsonToString(parsed)
      return parsed
    }
    return output
  } catch {
    return output
  }
}

/**
 * Build the template scope for a node: the inherited outer scope (subgraphs
 * see their enclosing variables), then every completed node in this graph by
 * name, then `env`. Later entries win, so a node can shadow an outer variable
 * of the same name — the same rule as lexical scoping.
 */
export function buildScope(
  outer: Scope | undefined,
  outputs: Map<string, string>,
  nodes: CanvasNode[]
): Scope {
  const inner: Scope = {}
  for (const [nodeId, output] of outputs) {
    const node = nodes.find((n) => n.id === nodeId)
    setUniqueAlias(inner, templateKeyForNode(node, nodeId), parseOutputValue(output))
  }
  const scope: Scope = { ...(outer ?? {}), ...inner }
  scope.env = { ...(outer?.env as Record<string, string> | undefined ?? {}), ...getEnvVars() }
  return scope
}
