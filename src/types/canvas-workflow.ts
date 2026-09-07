export interface CanvasInputNodeData {
  prompt: string
}

export interface CanvasAINodeData {
  providerId: string
  modelId?: string
  modeId?: string
  userPrompt: string
  outputSchema?: string
  maxRetries?: number
}

export interface CanvasAISessionNodeData {
  parentNodeId: string
  prompt: string
}

export interface CanvasShellNodeData {
  command: string
  cwd?: string
  timeoutMs?: number
  failOnNonZero?: boolean
}

export interface CanvasTemplateNodeData {
  template: string
}

export interface CanvasCodeNodeData {
  language: 'javascript'
  code: string
  timeoutMs?: number
}

export type CanvasConditionOperator =
  | 'is_true' | 'is_false' | 'is_empty' | 'not_empty'
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'matches'

export interface CanvasCondition {
  /** Variable path, e.g. `review.passed`. */
  variable: string
  operator: CanvasConditionOperator
  /** Comparison value (a template); unused for unary operators. */
  value?: string
}

/**
 * A condition is either built row by row or written as a bare expression;
 * `expression` wins when non-empty so the advanced mode stays authoritative.
 */
export interface CanvasConditionGroup {
  conditions?: CanvasCondition[]
  combinator?: 'and' | 'or'
  expression?: string
}

export interface CanvasIfCase extends CanvasConditionGroup {
  id: string
}

export interface CanvasIfNodeData {
  cases: CanvasIfCase[]
}

export const IF_ELSE_HANDLE = 'else'

export type CanvasHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type CanvasHttpBodyType = 'none' | 'json' | 'text' | 'form'
export type CanvasHttpAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }

export interface CanvasHttpNodeData {
  method: CanvasHttpMethod
  url: string
  headers: Array<{ key: string; value: string }>
  bodyType: CanvasHttpBodyType
  body: string
  auth: CanvasHttpAuth
  timeoutMs?: number
  failOnNon2xx?: boolean
}

export interface CanvasIterationNodeData {
  source: string
  sourceMode: 'json' | 'lines'
  concurrency?: number
  output: string
}

export interface CanvasLoopVariable {
  name: string
  initial: string
  next: string
}

export interface CanvasLoopNodeData {
  until: string
  untilConditions?: CanvasCondition[]
  untilCombinator?: 'and' | 'or'
  maxIterations: number
  variables: CanvasLoopVariable[]
  output: string
}

export const MAX_LOOP_ITERATIONS = 50
export const GROUP_NODE_TYPES = ['iteration', 'loop'] as const

export interface CanvasSubWorkflowNodeData {
  workflowId: number
  /** Display only; the id is the reference. */
  workflowName?: string
  /** Variables handed to the child: name → template, visible inside it as `{{ name }}`. */
  inputs: Array<{ key: string; value: string }>
}

export interface CanvasApprovalNodeData {
  message: string
  timeoutMs?: number
}

export interface CanvasEndNodeData {
  outputs: Array<{ key: string; value: string }>
}

export type CanvasNodeType =
  | 'input'
  | 'ai'
  | 'ai-session'
  | 'shell'
  | 'template'
  | 'code'
  | 'if'
  | 'http'
  | 'end'
  | 'iteration'
  | 'loop'
  | 'subworkflow'
  | 'approval'

export type CanvasNodeData =
  | CanvasInputNodeData
  | CanvasAINodeData
  | CanvasAISessionNodeData
  | CanvasShellNodeData
  | CanvasTemplateNodeData
  | CanvasCodeNodeData
  | CanvasIfNodeData
  | CanvasHttpNodeData
  | CanvasEndNodeData
  | CanvasIterationNodeData
  | CanvasLoopNodeData
  | CanvasSubWorkflowNodeData
  | CanvasApprovalNodeData

export interface CanvasNodeDef {
  id: string
  type: CanvasNodeType
  name: string
  position: { x: number; y: number }
  data: CanvasNodeData
  parentId?: string
  size?: { width: number; height: number }
}

export interface CanvasEdgeDef {
  id: string
  source: string
  target: string
  sourceHandle?: string
}

/** Workflow-level settings (none yet; reserved so the column has a shape). */
export type CanvasWorkflowSettings = Record<string, never>

export interface CanvasWorkflow {
  id: number
  name: string
  description?: string
  workspaceId?: number
  nodes: CanvasNodeDef[]
  edges: CanvasEdgeDef[]
  settings?: CanvasWorkflowSettings
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
  settings?: CanvasWorkflowSettings
}

export interface UpdateCanvasWorkflowInput {
  name?: string
  description?: string
  nodes?: CanvasNodeDef[]
  edges?: CanvasEdgeDef[]
  settings?: CanvasWorkflowSettings
}

export type NodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'waiting'

export interface NodeResult {
  nodeId: string
  status: NodeStatus
  output?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export type CanvasRunTrigger = 'manual' | 'cron' | 'subworkflow' | 'iteration' | 'loop'

export interface CanvasWorkflowRun {
  id: number
  workflowId: number
  status: 'running' | 'success' | 'error'
  error?: string
  startedAt: number
  finishedAt?: number
  outputs?: Record<string, string>
  nodeResults: NodeResult[]
  parentRunId?: number
  iteration?: number
  trigger?: CanvasRunTrigger
}
