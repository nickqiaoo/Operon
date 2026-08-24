export interface CanvasInputNodeData {
  prompt: string
}

export interface CanvasAINodeData {
  providerId: string
  modelId?: string
  modeId?: string
  userPrompt: string
}

export interface CanvasAISessionNodeData {
  parentNodeId: string
  prompt: string
}

export interface CanvasNodeDef {
  id: string
  type: 'input' | 'ai' | 'ai-session'
  name: string
  position: { x: number; y: number }
  data: CanvasInputNodeData | CanvasAINodeData | CanvasAISessionNodeData
}

export interface CanvasEdgeDef {
  id: string
  source: string
  target: string
}

export interface CanvasWorkflow {
  id: number
  name: string
  description?: string
  workspaceId?: number
  nodes: CanvasNodeDef[]
  edges: CanvasEdgeDef[]
  createdAt: number
  updatedAt: number
}

/**
 * The last run of a workflow, folded into the list response by the server so
 * the library can show run state per row without a request per workflow.
 */
export interface CanvasWorkflowLastRun {
  id: number
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
}

/** A workflow as the list endpoint returns it: the row plus its last run. */
export interface CanvasWorkflowListItem extends CanvasWorkflow {
  lastRun?: CanvasWorkflowLastRun
}

export interface CreateCanvasWorkflowInput {
  name: string
  description?: string
  workspaceId?: number
  nodes: CanvasNodeDef[]
  edges: CanvasEdgeDef[]
}

export interface UpdateCanvasWorkflowInput {
  name?: string
  description?: string
  nodes?: CanvasNodeDef[]
  edges?: CanvasEdgeDef[]
}

export type NodeStatus = 'pending' | 'running' | 'success' | 'error'

export interface NodeResult {
  nodeId: string
  status: NodeStatus
  output?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface CanvasWorkflowRun {
  id: number
  workflowId: number
  status: 'running' | 'success' | 'error'
  error?: string
  startedAt: number
  finishedAt?: number
  outputs?: Record<string, string>
  nodeResults: NodeResult[]
}
