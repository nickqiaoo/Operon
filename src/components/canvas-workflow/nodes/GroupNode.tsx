import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react"
import { cn } from "@/lib/utils"
import type { CanvasIterationNodeData, CanvasLoopNodeData } from "@/types/canvas-workflow"
import { NODE_TYPES, type CanvasNodeType } from "../node-registry"
import { NodeStatusBadge } from "../NodeStatusBadge"

/**
 * A container node. The body nodes are ReactFlow children (parentId), so
 * this component only draws the frame, the header and the progress line the
 * engine writes into the node's output while it runs.
 */
function GroupNodeCard({ type, data, selected, subtitle }: {
  type: CanvasNodeType
  data: NodeProps["data"]
  selected: boolean | undefined
  subtitle: string
}) {
  const meta = NODE_TYPES[type]
  const Icon = meta.icon
  const { name, status, progress } = data as { name: string; status?: string; progress?: string }

  return (
    <div
      className={cn(
        "group-node relative h-full w-full rounded-xl border-2 border-dashed bg-muted/10",
        selected ? "border-border" : "border-border/60 dark:border-border/35"
      )}
    >
      <NodeResizer minWidth={280} minHeight={160} isVisible={selected} lineClassName="!border-border/60" handleClassName="!h-2 !w-2 !rounded-sm !bg-background !border-border" />
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="flex items-center gap-2 rounded-t-[10px] border-b border-border/40 bg-muted/40 px-3 py-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.iconClass)} />
        <span className="text-xs font-medium truncate">{name}</span>
        <span className="text-[10px] text-muted-foreground/70 truncate flex-1">{subtitle}</span>
        {status === "running" && progress && (
          <span className="text-[10px] text-muted-foreground">{progress}</span>
        )}
        <NodeStatusBadge status={status} />
      </div>
      <div className="absolute bottom-1.5 right-2 text-[10px] text-muted-foreground/40 pointer-events-none">
        drag nodes here
      </div>
    </div>
  )
}

export function IterationNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasIterationNodeData }).nodeData
  const source = nodeData?.source?.trim()
  return (
    <GroupNodeCard
      type="iteration"
      data={data}
      selected={selected}
      subtitle={source ? `for each item in ${source}` : "for each item…"}
    />
  )
}

export function LoopNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasLoopNodeData }).nodeData
  const until = nodeData?.until?.trim()
  return (
    <GroupNodeCard
      type="loop"
      data={data}
      selected={selected}
      subtitle={until ? `until ${until} (max ${nodeData?.maxIterations ?? 5})` : `max ${nodeData?.maxIterations ?? 5} rounds`}
    />
  )
}
