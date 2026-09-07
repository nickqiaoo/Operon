import { type NodeProps } from "@xyflow/react"
import type { CanvasSubWorkflowNodeData } from "@/types/canvas-workflow"
import { SimpleNodeCard } from "./SimpleNode"

export function SubWorkflowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = (data as { nodeData?: CanvasSubWorkflowNodeData }).nodeData
  const preview = nodeData?.workflowId
    ? `Calls ${nodeData.workflowName ?? `workflow #${nodeData.workflowId}`}`
    : "No workflow selected"
  return <SimpleNodeCard type="subworkflow" data={data} selected={selected} preview={preview} />
}
