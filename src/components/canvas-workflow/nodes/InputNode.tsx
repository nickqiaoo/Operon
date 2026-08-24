import { type NodeProps } from "@xyflow/react"
import { FileInput } from "lucide-react"
import {
  Node,
  NodeHeader,
  NodeTitle,
  NodeContent,
} from "@/components/ai-elements/node"
import { cn } from "@/lib/utils"
import type { CanvasInputNodeData } from "@/types/canvas-workflow"
import { NodeStatusBadge } from "../NodeStatusBadge"

export type InputNodeData = {
  name: string
  nodeData: CanvasInputNodeData
  status?: string
}

export function InputNodeComponent({ data, selected }: NodeProps) {
  const { name, nodeData, status } = data as unknown as InputNodeData

  return (
    <Node
      handles={{ target: false, source: true }}
      className={cn(selected ? "ring-2 ring-blue-500/30" : "")}
    >
      <NodeHeader className="flex items-center gap-2">
        <FileInput className="h-3.5 w-3.5 text-blue-500 shrink-0" />
        <NodeTitle className="text-xs font-medium truncate flex-1">{name}</NodeTitle>
        <NodeStatusBadge status={status} />
      </NodeHeader>
      <NodeContent>
        <div className="text-xs text-muted-foreground line-clamp-2">
          {(nodeData?.prompt || "").slice(0, 80) || "No prompt set"}
        </div>
      </NodeContent>
    </Node>
  )
}
