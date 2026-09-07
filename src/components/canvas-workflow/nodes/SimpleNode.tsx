import { type NodeProps } from "@xyflow/react"
import { Node, NodeHeader, NodeTitle, NodeContent } from "@/components/ai-elements/node"
import { cn } from "@/lib/utils"
import { NODE_TYPES, type CanvasNodeType } from "../node-registry"
import { NodeStatusBadge } from "../NodeStatusBadge"

/**
 * Card for nodes whose whole configuration fits in one preview line
 * (shell / template / code). The IF node has its own card because it grows a
 * handle per case.
 */
export function SimpleNodeCard({
  type,
  data,
  selected,
  preview,
  mono,
  handles = { target: true, source: true },
}: {
  type: CanvasNodeType
  data: NodeProps["data"]
  selected: boolean | undefined
  preview: string
  mono?: boolean
  handles?: { target: boolean; source: boolean }
}) {
  const meta = NODE_TYPES[type]
  const Icon = meta.icon
  const { name, status } = data as { name: string; status?: string }

  return (
    <Node
      handles={handles}
      className={cn(selected ? "ring-2 ring-border/60" : "")}
    >
      <NodeHeader className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.iconClass)} />
        <NodeTitle className="text-xs font-medium truncate flex-1">{name}</NodeTitle>
        <NodeStatusBadge status={status} />
      </NodeHeader>
      <NodeContent>
        <div className={cn("text-xs text-muted-foreground line-clamp-2 break-all", mono && "font-mono text-[11px]")}>
          {preview}
        </div>
      </NodeContent>
    </Node>
  )
}
