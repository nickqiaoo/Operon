import { type NodeProps } from "@xyflow/react"
import { Brain, MessageSquare } from "lucide-react"
import {
  Node,
  NodeHeader,
  NodeTitle,
  NodeContent,
} from "@/components/ai-elements/node"
import { cn } from "@/lib/utils"
import type { CanvasAINodeData } from "@/types/canvas-workflow"
import { NodeStatusBadge } from "../NodeStatusBadge"

export type AINodeData = {
  name: string
  nodeData: CanvasAINodeData
  status?: string
  runId?: number
  onOpenChat?: (chatId: string, title: string, providerId: string) => void
}

export function AINodeComponent({ data, id, selected }: NodeProps) {
  const { name, nodeData, status, runId, onOpenChat } = data as unknown as AINodeData

  const chatId = runId ? `canvas:${runId}:${id}` : null
  const canOpenChat = chatId && (status === 'success' || status === 'error')

  return (
    <Node
      handles={{ target: true, source: true }}
      className={cn(selected ? "ring-2 ring-purple-500/30" : "")}
    >
      <NodeHeader className="flex items-center gap-2">
        <Brain className="h-3.5 w-3.5 text-purple-500 shrink-0" />
        <NodeTitle className="text-xs font-medium truncate flex-1">{name}</NodeTitle>
        {canOpenChat && onOpenChat && (
          <button
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-muted/60 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onOpenChat(chatId, `Workflow: ${name}`, nodeData?.providerId || '')
            }}
            title="Open in Chat"
          >
            <MessageSquare className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
        <NodeStatusBadge status={status} />
      </NodeHeader>
      <NodeContent>
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{nodeData?.providerId || "No provider"}</span>
          {nodeData?.modelId && (
            <span className="text-muted-foreground/60"> / {nodeData.modelId}</span>
          )}
        </div>
        {nodeData?.userPrompt && (
          <div className="text-xs text-muted-foreground/70 mt-1 line-clamp-2">
            {nodeData.userPrompt.slice(0, 80)}
          </div>
        )}
      </NodeContent>
    </Node>
  )
}
