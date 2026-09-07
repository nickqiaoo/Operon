// ---- Canvas Workflow Types ----

export interface CanvasInputNodeData {
  prompt: string
}

export interface CanvasAINodeData {
  providerId: string
  modelId?: string
  modeId?: string
  userPrompt: string
  /** JSON Schema text; when set the reply must be JSON that validates against it. */
  outputSchema?: string
  /** Correction rounds after an invalid reply. Default 2. */
  maxRetries?: number
}

export interface CanvasAISessionNodeData {
  parentNodeId: string
  prompt: string
}

export interface CanvasShellNodeData {
  /** Template; executed with `/bin/sh -c` in the workspace. */
  command: string
  /** Relative to the workspace root. */
  cwd?: string
  timeoutMs?: number
  /** Default true: a non-zero exit fails the node. */
  failOnNonZero?: boolean
}

export interface CanvasTemplateNodeData {
  template: string
}

export interface CanvasCodeNodeData {
  language: 'javascript'
  /** Function body; `inputs` holds every variable visible to templates. */
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

/** The source handle an IF node uses for the branch no case matched. */
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
  /** Default true: a non-2xx status fails the node. */
  failOnNon2xx?: boolean
}

export interface CanvasIterationNodeData {
  /** Template; must render to a JSON array (`json`) or multi-line text (`lines`). */
  source: string
  sourceMode: 'json' | 'lines'
  /** Bodies run in parallel up to this many at once. Default 4. */
  concurrency?: number
  /** Template evaluated at the end of each round against the body's variables; the round's result. */
  output: string
}

export interface CanvasLoopVariable {
  name: string
  /** Template for the first round. */
  initial: string
  /** Template evaluated at the end of each round (sees the body's variables + `loop`). */
  next: string
}

export interface CanvasLoopNodeData {
  /** Bare expression evaluated after each round; true exits. Advanced form of `untilConditions`. */
  until: string
  untilConditions?: CanvasCondition[]
  untilCombinator?: 'and' | 'or'
  /** Hard cap on rounds. Server rejects values above MAX_LOOP_ITERATIONS. */
  maxIterations: number
  variables: CanvasLoopVariable[]
  /** Template evaluated on exit; the node's output. */
  output: string
}

export const MAX_LOOP_ITERATIONS = 50
export const MAX_ITERATION_CONCURRENCY = 16

export interface CanvasSubWorkflowNodeData {
  workflowId: number
  /** Display only; the id is the reference. */
  workflowName?: string
  /** Variables handed to the child: name → template, visible inside it as `{{ name }}`. */
  inputs: Array<{ key: string; value: string }>
}

export interface CanvasApprovalNodeData {
  /** Template shown in the inbox request. */
  message: string
  /** Give up waiting after this long; undefined waits until the process exits. */
  timeoutMs?: number
}

export const MAX_SUBWORKFLOW_DEPTH = 8

export interface CanvasEndNodeData {
  /** Each value is a template; the rendered map is the workflow's output. */
  outputs: Array<{ key: string; value: string }>
}

/** Node types that contain other nodes on the canvas. */
export const GROUP_NODE_TYPES = ['iteration', 'loop'] as const

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

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  name: string
  /** Position is relative to the parent group when `parentId` is set. */
  position: { x: number; y: number }
  data: CanvasNodeData
  /** Group node (iteration / loop) this node lives in. */
  parentId?: string
  /** Group nodes remember their drawn size. */
  size?: { width: number; height: number }
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  /** Branch handle on the source (IF case id or `else`); absent for plain edges. */
  sourceHandle?: string
}

/** Workflow-level settings (none yet; reserved so the column has a shape). */
export type CanvasWorkflowSettings = Record<string, never>

export interface CanvasWorkflow {
  id: number
  name: string
  description?: string
  workspaceId?: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  settings?: CanvasWorkflowSettings
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
  settings?: CanvasWorkflowSettings
}

export interface UpdateCanvasWorkflowInput {
  name?: string
  description?: string
  nodes?: CanvasNode[]
  edges?: CanvasEdge[]
  settings?: CanvasWorkflowSettings
}

// ---- Execution Types ----

export type NodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'waiting'
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

export type CanvasRunTrigger = 'manual' | 'cron' | 'subworkflow' | 'iteration' | 'loop'

export interface CanvasWorkflowRun {
  id: number
  workflowId: number
  status: RunStatus
  error?: string
  startedAt: number
  finishedAt?: number
  outputs?: Record<string, string>
  nodeResults: NodeResult[]
  /** Set on runs that are the body of a group or sub-workflow node. */
  parentRunId?: number
  /** Which iteration of the parent group this run is (0-based). */
  iteration?: number
  trigger?: CanvasRunTrigger
}

export interface CreateCanvasRunOptions {
  parentRunId?: number
  iteration?: number
  trigger?: CanvasRunTrigger
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
  createRun(workflowId: number, options?: CreateCanvasRunOptions): number
  updateRunStatus(runId: number, status: 'success' | 'error', data?: { outputs?: Record<string, string>; error?: string }): void
  getRun(runId: number): CanvasWorkflowRun | null
  listRuns(workflowId: number, limit?: number): CanvasWorkflowRun[]

  // Node Results
  updateNodeResult(runId: number, nodeId: string, result: NodeResultUpdate): void
  getNodeResults(runId: number): NodeResult[]
}
