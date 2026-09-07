import { type NodeProps } from "@xyflow/react"
import type { CanvasEndNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function EndNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasEndNodeData }).nodeData
  const keys = (nodeData?.outputs ?? []).map((o) => o.key.trim()).filter(Boolean)
  return (
    <SimpleNodeCard
      type="end"
      data={data}
      selected={selected}
      preview={keys.length > 0 ? `Outputs: ${keys.join(", ")}` : "No outputs declared"}
      handles={{ target: true, source: false }}
    />
  )
}
