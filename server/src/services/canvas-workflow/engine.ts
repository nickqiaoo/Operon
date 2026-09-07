import type {
  CanvasAISessionNodeData,
  CanvasEdge,
  CanvasNode,
  CanvasWorkflow,
} from '../../types/canvas-workflow.js'
import { collectSessionParentIds } from './nodes/ai.js'
import { getNodeExecutor } from './nodes/registry.js'
import { buildScope, getNodeName, renderTemplate, type Scope } from './template.js'
import { truncateOutput, withTimeout } from './limits.js'
import type { CombinedStorage, NodeExecutionContext, RunSharedState } from './types.js'

// ---- Public shapes ----

export interface SubgraphRunOptions {
  runId: number
  workflowId: number
  workspaceId?: number
  storage: CombinedStorage
  /** Variables inherited from the enclosing graph (read-only for the subgraph). */
  scope?: Scope
  /** Workflow ids on the call stack, for sub-workflow cycle detection. */
  ancestorWorkflowIds?: Set<number>
  /** Iteration number when this subgraph is a loop / iteration body. */
  iteration?: number
  /** Persist per-node results to storage (off for loop bodies that would spam the run). */
  recordNodeResults?: boolean
  /**
   * A second run id that receives a copy of every node result. Group bodies
   * write their own child run and mirror into the top-level run, so the canvas
   * shows the current round live while history keeps every round.
   */
  mirrorRunId?: number
  /** The whole workflow, so group nodes can find their children and edges. */
  workflow?: CanvasWorkflow
}

export interface NodeFailure {
  nodeId: string
  name: string
  error: string
}

export interface SubgraphResult {
  /** Outputs of leaf nodes that completed, keyed by node name. */
  outputs: Record<string, string>
  /** Every completed node's output by node id. */
  nodeOutputs: Map<string, string>
  /** Final scope: inherited variables plus every completed node in this graph. */
  variables: Scope
  failed: NodeFailure[]
  skipped: string[]
}

// ---- Internal state ----

type ChannelStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped'

interface NodeChannel {
  nodeId: string
  pendingPredecessors: Set<string>
  /** Predecessors that completed successfully. Empty at ready time (with ≥1 predecessor) means skip. */
  completedPredecessors: Set<string>
  status: ChannelStatus
}

interface ExecutionState {
  options: SubgraphRunOptions
  nodes: CanvasNode[]
  channels: Map<string, NodeChannel>
  predecessors: Map<string, Set<string>>
  successors: Map<string, Set<string>>
  /** Drawn edges grouped by source, so branch handles can be checked on release. */
  edgesBySource: Map<string, CanvasEdge[]>
  runningPromises: Map<string, Promise<void>>
  outputs: Map<string, string>
  leafNodes: Set<string>
  failed: NodeFailure[]
  skipped: string[]
  /** Branch handles chosen by nodes that completed with `selectBranches`. */
  takenHandles: Map<string, Set<string>>
  shared: RunSharedState
  controller: AbortController
}

function buildGraph(nodes: CanvasNode[], edges: CanvasEdge[]): {
  predecessors: Map<string, Set<string>>
  successors: Map<string, Set<string>>
} {
  const predecessors = new Map<string, Set<string>>()
  const successors = new Map<string, Set<string>>()
  const nodeIds = new Set(nodes.map((n) => n.id))

  function addEdge(source: string, target: string): void {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return
    if (!successors.has(source)) successors.set(source, new Set())
    successors.get(source)!.add(target)
    if (!predecessors.has(target)) predecessors.set(target, new Set())
    predecessors.get(target)!.add(source)
  }

  for (const edge of edges) addEdge(edge.source, edge.target)

  // A session node continues its parent's chat, so it depends on the parent
  // even without a drawn edge.
  const sessionChildCount = new Map<string, number>()
  for (const node of nodes) {
    if (node.type !== 'ai-session') continue
    const data = node.data as CanvasAISessionNodeData
    addEdge(data.parentNodeId, node.id)
    const count = (sessionChildCount.get(data.parentNodeId) ?? 0) + 1
    sessionChildCount.set(data.parentNodeId, count)
    if (count > 1) {
      throw new Error(`Node "${data.parentNodeId}" has multiple session children. Each node can only have one session continuation.`)
    }
  }

  return { predecessors, successors }
}

function initExecutionState(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: SubgraphRunOptions
): ExecutionState {
  const { predecessors, successors } = buildGraph(nodes, edges)
  const channels = new Map<string, NodeChannel>()
  const leafNodes = new Set<string>()
  const edgesBySource = new Map<string, CanvasEdge[]>()
  for (const edge of edges) {
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, [])
    edgesBySource.get(edge.source)!.push(edge)
  }

  for (const node of nodes) {
    const preds = predecessors.get(node.id) ?? new Set<string>()
    channels.set(node.id, {
      nodeId: node.id,
      pendingPredecessors: new Set(preds),
      completedPredecessors: new Set(),
      status: 'pending',
    })
    if ((successors.get(node.id)?.size ?? 0) === 0) leafNodes.add(node.id)
  }

  return {
    options,
    nodes,
    channels,
    predecessors,
    successors,
    edgesBySource,
    runningPromises: new Map(),
    outputs: new Map(),
    leafNodes,
    failed: [],
    skipped: [],
    takenHandles: new Map(),
    shared: {
      nodes,
      sessionParentIds: collectSessionParentIds(nodes),
      nodeChatIds: new Map(),
      nodeSessionChatIds: new Map(),
    },
    controller: new AbortController(),
  }
}

// ---- Scheduling ----

function recordNodeResult(
  state: ExecutionState,
  nodeId: string,
  result: Parameters<CombinedStorage['updateCanvasNodeResult']>[2]
): void {
  if (state.options.recordNodeResults === false) return
  state.options.storage.updateCanvasNodeResult(state.options.runId, nodeId, result)
  if (state.options.mirrorRunId !== undefined) {
    state.options.storage.updateCanvasNodeResult(state.options.mirrorRunId, nodeId, result)
  }
}

/**
 * Let a settled node's successors know. `takenHandles` narrows which drawn
 * edges count as "completed": an IF node completes, but only the successors
 * on its chosen handle see a completed predecessor — the rest see a skip.
 * A session edge has no drawn edge and is always taken.
 */
function releaseSuccessors(
  nodeId: string,
  state: ExecutionState,
  completed: boolean,
  takenHandles?: Set<string>
): void {
  const drawn = state.edgesBySource.get(nodeId) ?? []
  for (const successorId of state.successors.get(nodeId) ?? []) {
    const channel = state.channels.get(successorId)!
    channel.pendingPredecessors.delete(nodeId)
    if (!completed) continue

    const edgesToSuccessor = drawn.filter((edge) => edge.target === successorId)
    const taken = edgesToSuccessor.length === 0
      || takenHandles === undefined
      || edgesToSuccessor.some((edge) => edge.sourceHandle === undefined || takenHandles.has(edge.sourceHandle))
    if (taken) channel.completedPredecessors.add(nodeId)
  }
}

/**
 * A node whose predecessors have all settled without any of them completing
 * has nothing to run on: it is skipped, and the skip flows downstream. Repeats
 * until no channel changes, so a whole dead branch settles in one pass.
 */
function settleSkips(state: ExecutionState): void {
  let changed = true
  while (changed) {
    changed = false
    for (const channel of state.channels.values()) {
      if (channel.status !== 'pending') continue
      if (channel.pendingPredecessors.size !== 0) continue
      const preds = state.predecessors.get(channel.nodeId)
      if (!preds || preds.size === 0) continue
      if (channel.completedPredecessors.size > 0) continue

      channel.status = 'skipped'
      state.skipped.push(channel.nodeId)
      recordNodeResult(state, channel.nodeId, { status: 'skipped', finishedAt: Date.now() })
      releaseSuccessors(channel.nodeId, state, false)
      changed = true
    }
  }
}

function getReadyNodes(state: ExecutionState): string[] {
  const ready: string[] = []
  for (const channel of state.channels.values()) {
    if (channel.status !== 'pending') continue
    if (channel.pendingPredecessors.size === 0) ready.push(channel.nodeId)
  }
  return ready
}

function allSettled(state: ExecutionState): boolean {
  for (const channel of state.channels.values()) {
    if (channel.status === 'pending' || channel.status === 'running') return false
  }
  return true
}

async function waitForAnyCompletion(state: ExecutionState): Promise<string> {
  const entries = Array.from(state.runningPromises.entries())
  return Promise.race(entries.map(async ([nodeId, promise]) => {
    await promise
    return nodeId
  }))
}

function resolveWorkspaceCwd(storage: CombinedStorage, workspaceId?: number): string {
  if (workspaceId !== undefined) {
    const workspace = storage.getWorkspace(workspaceId)
    if (workspace) return workspace.worktreePath
  }
  return process.cwd()
}

async function executeNode(nodeId: string, state: ExecutionState): Promise<void> {
  const channel = state.channels.get(nodeId)!
  const node = state.nodes.find((n) => n.id === nodeId)!
  const { storage, runId, workflowId, workspaceId } = state.options

  channel.status = 'running'
  recordNodeResult(state, nodeId, { status: 'running', startedAt: Date.now() })

  try {
    const definition = getNodeExecutor(node.type)
    const scope = buildScope(state.options.scope, state.outputs, state.nodes)
    const label = `${node.type} node "${getNodeName(node, nodeId)}"`

    const output = await withTimeout(async (signal) => {
      const ctx: NodeExecutionContext = {
        nodeId,
        node,
        runId,
        workflowId,
        workspaceId,
        cwd: resolveWorkspaceCwd(storage, workspaceId),
        options: state.options,
        scope,
        render: (template) => renderTemplate(template, scope),
        run: state.shared,
        storage,
        signal,
      }
      return truncateOutput(await definition.execute(ctx))
    }, definition.timeoutMs?.(node), label)

    channel.status = 'completed'
    state.outputs.set(nodeId, output)
    if (definition.selectBranches) {
      state.takenHandles.set(nodeId, new Set(definition.selectBranches(output, node)))
    }
    recordNodeResult(state, nodeId, { status: 'success', output, finishedAt: Date.now() })
  } catch (error) {
    const message = (error as Error).message
    channel.status = 'error'
    state.failed.push({ nodeId, name: getNodeName(node, nodeId), error: message })
    recordNodeResult(state, nodeId, { status: 'error', error: message, finishedAt: Date.now() })
  }
}

function collectLeafOutputs(state: ExecutionState): Record<string, string> {
  const outputs: Record<string, string> = {}
  for (const leafId of state.leafNodes) {
    const output = state.outputs.get(leafId)
    if (output === undefined) continue
    const node = state.nodes.find((n) => n.id === leafId)
    outputs[getNodeName(node, leafId)] = output
  }
  return outputs
}

async function disposeSharedSessions(state: ExecutionState): Promise<void> {
  if (state.shared.nodeSessionChatIds.size === 0) return
  const { getSessionManager } = await import('../ai.js')
  const sessionManager = getSessionManager()
  for (const chatId of state.shared.nodeSessionChatIds.values()) {
    await sessionManager.destroy(chatId).catch(() => {})
  }
}

/**
 * Run a set of nodes and edges to completion. Nodes start as soon as their
 * predecessors settle (wait-for-any, not wait-for-all), a failed node stops
 * only its own downstream, and the caller decides what a failure means for
 * the run. The same routine drives the top-level workflow, iteration / loop
 * bodies and sub-workflows.
 */
export async function runSubgraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: SubgraphRunOptions
): Promise<SubgraphResult> {
  const state = initExecutionState(nodes, edges, options)

  try {
    while (true) {
      settleSkips(state)
      for (const nodeId of getReadyNodes(state)) {
        state.runningPromises.set(nodeId, executeNode(nodeId, state))
      }
      if (allSettled(state)) break
      if (state.runningPromises.size === 0) {
        throw new Error('Workflow stalled: no nodes ready and none running')
      }

      const completedNodeId = await waitForAnyCompletion(state)
      state.runningPromises.delete(completedNodeId)
      const channel = state.channels.get(completedNodeId)!
      releaseSuccessors(
        completedNodeId,
        state,
        channel.status === 'completed',
        state.takenHandles.get(completedNodeId)
      )
    }

    return {
      outputs: collectLeafOutputs(state),
      nodeOutputs: state.outputs,
      variables: buildScope(options.scope, state.outputs, nodes),
      failed: state.failed,
      skipped: state.skipped,
    }
  } finally {
    state.controller.abort()
    await disposeSharedSessions(state)
  }
}
