import { type NodeProps } from "@xyflow/react"
import { Link2, MessageSquare } from "lucide-react"
import {
  Node,
  NodeHeader,
  NodeTitle,
  NodeContent,
} from "@/components/ai-elements/node"
import { cn } from "@/lib/utils"
import type { CanvasAISessionNodeData } from "@/types/canvas-workflow"
import { NodeStatusBadge } from "../NodeStatusBadge"

export type AISessionNodeData = {
  name: string
  nodeData: CanvasAISessionNodeData
  parentName?: string
  parentProviderId?: string
  status?: string
  runId?: number
  onOpenChat?: (chatId: string, title: string, providerId: string) => void
}

export function AISessionNodeComponent({ data, selected }: NodeProps) {
  const { name, nodeData, parentName, parentProviderId, status, runId, onOpenChat } = data as unknown as AISessionNodeData

  const chatId = runId && nodeData?.parentNodeId ? `canvas:${runId}:${nodeData.parentNodeId}` : null
  const canOpenChat = chatId && (status === 'success' || status === 'error')

  return (
    <Node
      handles={{ target: true, source: true }}
      className={cn(selected ? "ring-2 ring-cyan-500/30" : "")}
    >
      <NodeHeader className="flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-blue-500 shrink-0" />
        <NodeTitle className="text-xs font-medium truncate flex-1">{name}</NodeTitle>
        {canOpenChat && onOpenChat && (
          <button
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-muted/60 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onOpenChat(chatId, `Workflow: ${name}`, parentProviderId || '')
            }}
            title="Open in Chat"
          >
            <MessageSquare className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
        <NodeStatusBadge status={status} />
      </NodeHeader>
      <NodeContent>
        <div className="text-xs text-blue-500/80 flex items-center gap-1">
          <Link2 className="h-2.5 w-2.5" />
          <span>Session of: {parentName || nodeData?.parentNodeId || "unknown"}</span>
        </div>
        {nodeData?.prompt && (
          <div className="text-xs text-muted-foreground/70 mt-1 line-clamp-2">
            {nodeData.prompt.slice(0, 80)}
          </div>
        )}
      </NodeContent>
    </Node>
  )
}
