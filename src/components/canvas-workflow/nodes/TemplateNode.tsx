import { type NodeProps } from "@xyflow/react"
import type { CanvasTemplateNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function TemplateNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasTemplateNodeData }).nodeData
  return (
    <SimpleNodeCard
      type="template"
      data={data}
      selected={selected}
      preview={nodeData?.template?.trim() || "No template set"}
    />
  )
}
