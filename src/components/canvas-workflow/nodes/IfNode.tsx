import { Handle, Position, type NodeProps } from "@xyflow/react"
import { Node, NodeHeader, NodeTitle, NodeContent } from "@/components/ai-elements/node"
import { cn } from "@/lib/utils"
import { IF_ELSE_HANDLE, type CanvasIfCase, type CanvasIfNodeData } from "@/types/canvas-workflow"
import { NODE_TYPES } from "../node-registry"
import { NodeStatusBadge } from "../NodeStatusBadge"

const OPERATOR_TEXT: Record<string, string> = {
  is_true: "is true", is_false: "is false", is_empty: "is empty", not_empty: "not empty",
  equals: "==", not_equals: "!=", contains: "contains", not_contains: "excludes",
  gt: ">", gte: ">=", lt: "<", lte: "<=", matches: "~",
}

function summarizeCase(c: CanvasIfCase): string {
  if (c.expression?.trim()) return c.expression.trim()
  const rows = (c.conditions ?? []).filter((r) => r.variable.trim())
  return rows
    .map((r) => `${r.variable} ${OPERATOR_TEXT[r.operator] ?? r.operator}${r.value !== undefined && !["is_true", "is_false", "is_empty", "not_empty"].includes(r.operator) ? ` ${r.value}` : ""}`)
    .join(c.combinator === "or" ? " or " : " and ")
}

/**
 * One source handle per case plus a fixed `else`, each sitting on its own row
 * so an edge visibly leaves from the condition it belongs to.
 */
export function IfNodeComponent({ data, selected }: NodeProps) {
  const meta = NODE_TYPES.if
  const Icon = meta.icon
  const { name, status } = data as { name: string; status?: string }
  const nodeData = (data as { nodeData?: CanvasIfNodeData }).nodeData
  const cases = nodeData?.cases ?? []

  return (
    <Node
      handles={{ target: true, source: false }}
      className={cn(selected ? "ring-2 ring-border/60" : "")}
    >
      <NodeHeader className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.iconClass)} />
        <NodeTitle className="text-xs font-medium truncate flex-1">{name}</NodeTitle>
        <NodeStatusBadge status={status} />
      </NodeHeader>
      <NodeContent className="p-0 py-1">
        {cases.map((c) => (
          <div key={c.id} className="relative flex items-center gap-2 px-3 py-1">
            <span className="w-10 shrink-0 text-[10px] font-mono text-muted-foreground/70">{c.id}</span>
            <span className="flex-1 truncate text-[11px] font-mono text-muted-foreground">
              {summarizeCase(c) || <span className="italic text-muted-foreground/50">empty</span>}
            </span>
            <Handle type="source" position={Position.Right} id={c.id} />
          </div>
        ))}
        <div className="relative flex items-center gap-2 px-3 py-1">
          <span className="w-10 shrink-0 text-[10px] font-mono text-muted-foreground/70">else</span>
          <span className="flex-1 text-[11px] text-muted-foreground/50">no case matched</span>
          <Handle type="source" position={Position.Right} id={IF_ELSE_HANDLE} />
        </div>
      </NodeContent>
    </Node>
  )
}
