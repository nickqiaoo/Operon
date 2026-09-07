import { type NodeProps } from "@xyflow/react"
import type { CanvasHttpNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function HttpNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasHttpNodeData }).nodeData
  const preview = nodeData?.url?.trim()
    ? `${nodeData.method ?? "GET"} ${nodeData.url.trim()}`
    : "No URL set"
  return <SimpleNodeCard type="http" data={data} selected={selected} preview={preview} mono />
}
