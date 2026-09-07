import { type NodeProps } from "@xyflow/react"
import type { CanvasApprovalNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function ApprovalNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasApprovalNodeData }).nodeData
  return (
    <SimpleNodeCard
      type="approval"
      data={data}
      selected={selected}
      preview={nodeData?.message?.trim() || "Waits for approval in the inbox"}
    />
  )
}
