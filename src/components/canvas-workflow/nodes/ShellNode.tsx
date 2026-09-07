import { type NodeProps } from "@xyflow/react"
import type { CanvasShellNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function ShellNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasShellNodeData }).nodeData
  return (
    <SimpleNodeCard
      type="shell"
      data={data}
      selected={selected}
      preview={nodeData?.command?.trim() || "No command set"}
      mono
    />
  )
}
