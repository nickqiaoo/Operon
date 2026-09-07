import type { CanvasNode } from '../../types/canvas-workflow.js'
import type {
  CanvasWorkflowStorageAdapter,
  ChatStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
} from '../../storage/interface.js'
import type { Scope } from './template.js'
import type { SubgraphRunOptions } from './engine.js'

export type CombinedStorage = CanvasWorkflowStorageAdapter & ChatStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter

/**
 * State shared by every node in one run of one graph. AI nodes park their chat
 * ids here so a session node can continue the conversation its parent opened.
 */
export interface RunSharedState {
  nodes: CanvasNode[]
  /** AI nodes that have a session child and must keep their chat alive. */
  sessionParentIds: Set<string>
  nodeChatIds: Map<string, number>
  nodeSessionChatIds: Map<string, number>
}

export interface NodeExecutionContext {
  nodeId: string
  node: CanvasNode
  runId: number
  workflowId: number
  workspaceId?: number
  cwd: string
  /** The run options this node executes under (group nodes recurse with them). */
  options: SubgraphRunOptions
  /** Variables visible to this node's templates. */
  scope: Scope
  /** Render a template against `scope`. */
  render(template: string): string
  run: RunSharedState
  storage: CombinedStorage
  signal: AbortSignal
}

export type NodeExecutor = (ctx: NodeExecutionContext) => Promise<string> | string

export interface NodeExecutorDefinition {
  execute: NodeExecutor
  /** Wall-clock budget for one execution; undefined means no engine-imposed timeout (AI nodes). */
  timeoutMs?: (node: CanvasNode) => number | undefined
  /**
   * For branching nodes: which source handles the run continues through.
   * Edges leaving the node on any other handle are treated as not taken.
   */
  selectBranches?: (output: string, node: CanvasNode) => string[]
}
