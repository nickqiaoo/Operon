import { useMemo } from "react"
import type { Edge } from "@xyflow/react"
import type { CanvasWorkflowRun } from "@/types/canvas-workflow"
import type { CanvasNode } from "@/components/canvas-workflow/utils/canvasConversions"
import { fromReactFlowNodeType } from "../node-registry"

export interface AvailableVariable {
  /** Template path, e.g. `review.passed`. */
  path: string
  /** Where it comes from: an upstream node, the enclosing group, a calling workflow, or the environment. */
  source: "node" | "group" | "caller" | "env"
  /** Short value preview from the last run, when there is one. */
  preview?: string
  /** Nested fields discovered from the last run's JSON output. */
  children?: AvailableVariable[]
}

const MAX_DEPTH = 3
const MAX_CHILDREN = 30

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return ""
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** Turn a JSON value into a tree of paths (objects by key, arrays by index). */
function expand(path: string, value: unknown, depth: number): AvailableVariable[] {
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return []
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.slice(0, MAX_CHILDREN).map((v, i) => [`${path}[${i}]`, v])
    : Object.entries(value as Record<string, unknown>).slice(0, MAX_CHILDREN).map(([k, v]) => [/^[A-Za-z_]\w*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`, v])
  return entries.map(([childPath, childValue]) => ({
    path: childPath,
    source: "node" as const,
    preview: previewOf(childValue),
    children: expand(childPath, childValue, depth + 1),
  }))
}

function parseOutput(output: string | undefined): unknown {
  if (!output) return undefined
  const trimmed = output.trim()
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return output
  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

/** Every node that can run before `nodeId`: transitive predecessors, plus, inside a group, the group's own upstream. */
function upstreamOf(nodeId: string, nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const predecessors = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!predecessors.has(e.target)) predecessors.set(e.target, new Set())
    predecessors.get(e.target)!.add(e.source)
  }
  const seen = new Set<string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const pred of predecessors.get(current) ?? []) {
      if (!seen.has(pred)) { seen.add(pred); stack.push(pred) }
    }
    // A node inside a group also sees what the group itself depends on.
    const parentId = byId.get(current)?.parentId
    if (parentId && !seen.has(parentId)) { seen.add(parentId); stack.push(parentId) }
  }
  seen.delete(nodeId)
  return [...seen].map((id) => byId.get(id)).filter((n): n is CanvasNode => n !== undefined)
}

function templateKey(name: string): string {
  const trimmed = name.trim()
  if (/^[A-Za-z_]\w*$/.test(trimmed)) return trimmed
  const normalized = trimmed.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  if (normalized.length === 0) return "node"
  return /^[0-9]/.test(normalized) ? `node_${normalized}` : normalized
}

/**
 * The variables a node's templates may reference: upstream node outputs
 * (expanded from the last run when possible), the enclosing group's
 * iteration / loop variables, and `env`.
 */
export interface CallerVariable {
  name: string
  /** Workflows that pass this variable in. */
  from: string[]
}

export function computeAvailableVariables(
  nodeId: string | null,
  nodes: CanvasNode[],
  edges: Edge[],
  lastRun: CanvasWorkflowRun | null | undefined,
  callerVariables: CallerVariable[] = []
): AvailableVariable[] {
  if (!nodeId) return []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const self = byId.get(nodeId)
  const results = new Map((lastRun?.nodeResults ?? []).map((r) => [r.nodeId, r]))
  const variables: AvailableVariable[] = []

  for (const node of upstreamOf(nodeId, nodes, edges)) {
    // The enclosing group's own output does not exist yet while its body runs.
    if (self?.parentId === node.id) continue
    const path = templateKey((node.data.name as string) || node.id)
    const value = parseOutput(results.get(node.id)?.output)
    variables.push({
      path,
      source: "node",
      preview: value === undefined ? undefined : previewOf(value),
      children: expand(path, value, 0),
    })
  }

  if (self?.parentId) {
    const group = byId.get(self.parentId)
    const groupType = group ? fromReactFlowNodeType(group.type ?? "") : undefined
    if (groupType === "iteration") {
      variables.push({ path: "item", source: "group", preview: "current element" })
      variables.push({ path: "index", source: "group", preview: "0-based position" })
    } else if (groupType === "loop") {
      const loopVars = ((group?.data.nodeData as { variables?: Array<{ name: string }> } | undefined)?.variables ?? [])
        .map((v) => v.name.trim()).filter(Boolean)
      variables.push({
        path: "loop",
        source: "group",
        preview: "round state",
        children: [
          { path: "loop.index", source: "group", preview: "0-based round" },
          ...loopVars.map((name) => ({ path: `loop.${name}`, source: "group" as const })),
        ],
      })
    }
  }

  for (const caller of callerVariables) {
    variables.push({ path: caller.name, source: "caller", preview: `from ${caller.from.join(", ")}` })
  }

  variables.push({ path: "env", source: "env", preview: "environment variables from Settings" })
  return variables
}

export function useAvailableVariables(
  nodeId: string | null,
  nodes: CanvasNode[],
  edges: Edge[],
  lastRun: CanvasWorkflowRun | null | undefined,
  callerVariables: CallerVariable[] = []
): AvailableVariable[] {
  return useMemo(
    () => computeAvailableVariables(nodeId, nodes, edges, lastRun, callerVariables),
    [nodeId, nodes, edges, lastRun, callerVariables]
  )
}

/** Root names a template may legitimately start an expression with, given the scope. */
export function rootNames(variables: AvailableVariable[]): Set<string> {
  return new Set(variables.map((v) => v.path.split(/[.[]/)[0]))
}
