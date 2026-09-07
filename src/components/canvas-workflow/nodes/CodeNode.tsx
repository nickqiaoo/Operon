import { type NodeProps } from "@xyflow/react"
import type { CanvasCodeNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function CodeNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasCodeNodeData }).nodeData
  return (
    <SimpleNodeCard
      type="code"
      data={data}
      selected={selected}
      preview={nodeData?.code?.trim() || "No code set"}
      mono
    />
  )
}
