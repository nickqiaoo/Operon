// ---- Canvas Workflow Types ----

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

export interface CanvasNode {
  id: string
  type: 'input' | 'ai' | 'ai-session'
  name: string
  position: { x: number; y: number }
  data: CanvasInputNodeData | CanvasAINodeData | CanvasAISessionNodeData
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
}

export interface CanvasWorkflow {
  id: number
  name: string
  description?: string
  workspaceId?: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  createdAt: number
  updatedAt: number
}

/**
 * The last run of a workflow, folded into the list response.
 *
 * The library view has to show run state per row, and fetching it row by row
 * would be one request per workflow. The list query joins it in instead, so a
 * library of any size stays one round trip.
 */
export interface CanvasWorkflowLastRun {
  id: number
  status: RunStatus
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
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface UpdateCanvasWorkflowInput {
  name?: string
  description?: string
  nodes?: CanvasNode[]
  edges?: CanvasEdge[]
}

// ---- Execution Types ----

export type NodeStatus = 'pending' | 'running' | 'success' | 'error'
export type RunStatus = 'running' | 'success' | 'error'

export interface NodeResult {
  nodeId: string
  status: NodeStatus
  output?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface NodeResultUpdate {
  status: NodeStatus
  output?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface CanvasWorkflowRun {
  id: number
  workflowId: number
  status: RunStatus
  error?: string
  startedAt: number
  finishedAt?: number
  outputs?: Record<string, string>
  nodeResults: NodeResult[]
}

// ---- Storage Interface ----

export interface CanvasWorkflowStorageAdapter {
  // Workflow CRUD
  createWorkflow(input: CreateCanvasWorkflowInput): CanvasWorkflow
  getWorkflow(id: number): CanvasWorkflow | null
  listWorkflows(workspaceId?: number): CanvasWorkflow[]
  updateWorkflow(id: number, updates: UpdateCanvasWorkflowInput): void
  deleteWorkflow(id: number): void

  // Run Management
  createRun(workflowId: number): number
  updateRunStatus(runId: number, status: 'success' | 'error', data?: { outputs?: Record<string, string>; error?: string }): void
  getRun(runId: number): CanvasWorkflowRun | null
  listRuns(workflowId: number, limit?: number): CanvasWorkflowRun[]

  // Node Results
  updateNodeResult(runId: number, nodeId: string, result: NodeResultUpdate): void
  getNodeResults(runId: number): NodeResult[]
}
