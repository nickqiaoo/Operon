import type { Edge, Node } from "@xyflow/react"
import type {
  CanvasNodeDef,
  CanvasEdgeDef,
  CanvasAISessionNodeData,
} from "@/types/canvas-workflow"

export type CanvasNode = Node<Record<string, unknown>>
export type CanvasEdge = Edge

function getNodeName(node: CanvasNodeDef): string {
  return node.name || node.id
}

/** Map backend node type to ReactFlow node type */
export function toReactFlowNodeType(backendType: CanvasNodeDef["type"]): string {
  switch (backendType) {
    case "input": return "inputNode"
    case "ai": return "aiNode"
    case "ai-session": return "aiSessionNode"
    default: return "aiNode"
  }
}

/** Map ReactFlow node type to backend node type */
export function fromReactFlowNodeType(rfType: string): CanvasNodeDef["type"] {
  switch (rfType) {
    case "inputNode": return "input"
    case "aiNode": return "ai"
    case "aiSessionNode": return "ai-session"
    default: return "ai"
  }
}

/** Walk parentNodeId chain to find root AI node info */
export function findRootAINodeInfo(
  nodeId: string,
  allDefs: CanvasNodeDef[]
): { name: string; providerId: string } | null {
  const node = allDefs.find(n => n.id === nodeId)
  if (!node) return null
  if (node.type === "ai") {
    const data = node.data as { providerId?: string }
    return { name: getNodeName(node), providerId: data.providerId || "" }
  }
  if (node.type === "ai-session") {
    const data = node.data as CanvasAISessionNodeData
    return findRootAINodeInfo(data.parentNodeId, allDefs)
  }
  return null
}

/** Convert backend nodes to ReactFlow nodes */
export function toReactFlowNodes(defs: CanvasNodeDef[]): CanvasNode[] {
  return defs.map((n) => {
    const nodeName = getNodeName(n)
    const baseData: Record<string, unknown> = {
      name: nodeName,
      nodeData: n.data,
    }

    // For ai-session nodes, resolve parent info for display
    if (n.type === "ai-session") {
      const sessionData = n.data as CanvasAISessionNodeData
      const parentDef = defs.find(d => d.id === sessionData.parentNodeId)
      baseData.parentName = parentDef ? getNodeName(parentDef) : sessionData.parentNodeId
      const rootInfo = findRootAINodeInfo(sessionData.parentNodeId, defs)
      if (rootInfo) {
        baseData.parentProviderId = rootInfo.providerId
      }
    }

    return {
      id: n.id,
      type: toReactFlowNodeType(n.type),
      position: n.position,
      data: baseData,
    }
  })
}

/** Convert backend edges to ReactFlow edges, with session edge styling */
export function toReactFlowEdges(defs: CanvasEdgeDef[], nodes: CanvasNodeDef[]): CanvasEdge[] {
  return defs.map((e) => {
    const targetNode = nodes.find(n => n.id === e.target)

    // Check if this is a session edge (target is a session node and source is its parent)
    if (targetNode?.type === 'ai-session') {
      const sessionData = targetNode.data as CanvasAISessionNodeData
      if (sessionData.parentNodeId === e.source) {
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          style: {
            strokeDasharray: '8 4',
            strokeWidth: 2.5,
            stroke: '#6366f1',
            opacity: 0.6,
          },
          data: { isSessionEdge: true },
          type: 'default',
        }
      }
    }

    return {
      id: e.id,
      source: e.source,
      target: e.target,
    }
  })
}

/** Convert ReactFlow nodes back to backend format */
export function fromReactFlowNodes(nodes: CanvasNode[]): CanvasNodeDef[] {
  return nodes.map((n) => ({
    id: n.id,
    type: fromReactFlowNodeType(n.type || "aiNode"),
    name: (n.data.name as string) || "Untitled",
    position: n.position,
    data: n.data.nodeData as CanvasNodeDef["data"],
  }))
}

/** Convert ReactFlow edges back to backend format */
export function fromReactFlowEdges(edges: CanvasEdge[]): CanvasEdgeDef[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }))
}
