import { randomUUID } from 'crypto'
import nunjucks from 'nunjucks'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type {
  CanvasNode,
  CanvasWorkflow,
  CanvasAINodeData,
  CanvasAISessionNodeData,
  CanvasInputNodeData,
} from '../types/canvas-workflow.js'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import { getSessionManager, startChat } from './ai.js'
import { readPreparedTextStreamParts } from './ai/prepared-stream-parts.js'
import { createUiStreamFromTextParts } from './ai/text-stream-part-to-ui.js'

// ---- Template Engine (Jinja/Nunjucks) ----

const templateEnv = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
})

/**
 * Render a Jinja-style template with the given inputs.
 *
 * Template variables:
 *   {{ <nodeName> }} — input keyed by source node name (e.g. {{ summary }})
 */
function resolveTemplate(
  template: string,
  inputs: Record<string, string>
): string {
  // Build context: node-name keyed aliases only
  const ctx: Record<string, string> = { ...inputs }

  return templateEnv.renderString(template, ctx)
}

function getNodeName(node: CanvasNode | undefined, fallbackId: string): string {
  if (!node) return fallbackId
  const name = node.name.trim()
  return name.length > 0 ? name : fallbackId
}

function sanitizeTemplateKey(rawName: string): string {
  const normalized = rawName.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (normalized.length === 0) return 'node'
  return /^[0-9]/.test(normalized) ? `node_${normalized}` : normalized
}

function isTemplateIdentifier(rawName: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName)
}

function setUniqueAlias(
  aliases: Record<string, string>,
  baseKey: string,
  value: string
): void {
  if (!(baseKey in aliases)) {
    aliases[baseKey] = value
    return
  }

  let suffix = 2
  let candidate = `${baseKey}_${suffix}`
  while (candidate in aliases) {
    suffix += 1
    candidate = `${baseKey}_${suffix}`
  }
  aliases[candidate] = value
}

function buildTemplateInputs(
  receivedInputs: Map<string, string>,
  nodes: CanvasNode[]
): Record<string, string> {
  const aliases: Record<string, string> = {}

  for (const [sourceNodeId, output] of receivedInputs) {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId)
    const sourceName = getNodeName(sourceNode, sourceNodeId)
    const key = isTemplateIdentifier(sourceName) ? sourceName : sanitizeTemplateKey(sourceName)
    setUniqueAlias(aliases, key, output)
  }

  return aliases
}

// ---- Session Chain Helpers ----

function findRootAINode(nodeId: string, nodes: CanvasNode[]): CanvasNode {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Node not found: ${nodeId}`)
  if (node.type === 'ai') return node
  if (node.type === 'ai-session') {
    const data = node.data as CanvasAISessionNodeData
    return findRootAINode(data.parentNodeId, nodes)
  }
  throw new Error(`Cannot find root AI node from node type: ${node.type}`)
}

function collectSessionParentIds(nodes: CanvasNode[]): Set<string> {
  const rootIds = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'ai-session') {
      const root = findRootAINode(node.id, nodes)
      rootIds.add(root.id)
    }
  }
  return rootIds
}

// ---- Node Execution Context ----

interface NodeExecutionContext {
  nodeId: string
  node: CanvasNode
  runId: number
  workflowId: number
  workspaceId?: number
  cwd: string
  inputs: Record<string, string>
}

// ---- Combined Storage ----

type CombinedStorage = CanvasWorkflowStorageAdapter & ChatStorageAdapter & ProjectStorageAdapter

function createCanvasTextMessage(
  role: 'user' | 'assistant',
  content: string
): UIMessage {
  return {
    id: randomUUID(),
    role,
    parts: [
      {
        type: 'text',
        text: content,
      },
    ],
  }
}

function extractTextFromMessage(message: UIMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * Strip echoed user prompt from the beginning of assistant parts.
 * Some providers echo the user prompt as a text part before the actual response.
 * `step-start` is ignored when determining "first content".
 */
function stripEchoedPrompt(message: UIMessage, userPrompt: string): UIMessage {
  const trimmedPrompt = userPrompt.trim()
  let stripped = false
  const cleaned = message.parts.filter((part) => {
    if (stripped || part.type === 'step-start') return true
    if (part.type === 'text' && part.text.trim() === trimmedPrompt) {
      stripped = true
      return false
    }
    return true
  })
  return { ...message, parts: cleaned }
}

async function collectAssistantMessage(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage | undefined> {
  let latestMessage: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream })) {
    latestMessage = message
  }
  return latestMessage
}

function resolveWorkspaceCwd(storage: CombinedStorage, workspaceId?: number): string {
  if (workspaceId !== undefined) {
    const workspace = storage.getWorkspace(workspaceId)
    if (workspace) return workspace.worktreePath
  }
  return process.cwd()
}

function requireWorkspaceId(workspaceId?: number): number {
  if (workspaceId === undefined) {
    throw new Error('Canvas AI nodes require a workspace to use the unified chat flow')
  }
  return workspaceId
}

// ---- Node Executors ----

function executeInputNode(ctx: NodeExecutionContext): string {
  const data = ctx.node.data as CanvasInputNodeData
  return data.prompt
}

async function executeAINode(
  ctx: NodeExecutionContext,
  state: ExecutionState
): Promise<string> {
  const data = ctx.node.data as CanvasAINodeData
  const userPrompt = resolveTemplate(data.userPrompt, ctx.inputs)
  const userMessage = createCanvasTextMessage('user', userPrompt)
  const workspaceId = requireWorkspaceId(ctx.workspaceId)
  const isShared = state.sessionParentIds.has(ctx.nodeId)
  let chatCtx: Awaited<ReturnType<typeof startChat>> | undefined

  try {
    chatCtx = await startChat({
      messages: [userMessage],
      providerId: data.providerId,
      modelId: data.modelId,
      workspaceId,
      modeId: data.modeId ?? 'auto',
      tp: 'canvas',
      skipSnapshot: true,
    })

    state.nodeChatIds.set(ctx.nodeId, chatCtx.chatId)
    if (isShared) {
      state.nodeSessionChatIds.set(ctx.nodeId, chatCtx.chatId)
    }

    const assistantMessage = await collectAssistantMessage(createUiStreamFromTextParts({
      originalMessages: chatCtx.normalizedMessages,
      messageId: chatCtx.assistantMessageId,
      parts: readPreparedTextStreamParts(chatCtx.preparedParts),
    }))
    await chatCtx.persistDone

    const cleanedAssistant = assistantMessage?.role === 'assistant'
      ? stripEchoedPrompt(assistantMessage, userPrompt)
      : undefined

    return extractTextFromMessage(cleanedAssistant)
  } finally {
    chatCtx?.finish()
    if (chatCtx && !isShared) {
      await getSessionManager().destroy(chatCtx.chatId).catch(() => {})
    }
  }
}

async function executeAISessionNode(
  ctx: NodeExecutionContext,
  state: ExecutionState
): Promise<string> {
  const data = ctx.node.data as CanvasAISessionNodeData
  const rootNode = findRootAINode(data.parentNodeId, state.workflow.nodes)
  const rootData = rootNode.data as CanvasAINodeData

  // Get the chatId created by the root AI node
  const chatId = state.nodeChatIds.get(rootNode.id)
  if (chatId === undefined) {
    throw new Error(`No chat found for root node: ${rootNode.id}. Ensure the root AI node executed first.`)
  }

  const userPrompt = resolveTemplate(data.prompt, ctx.inputs)
  const userMessage = createCanvasTextMessage('user', userPrompt)
  const workspaceId = requireWorkspaceId(ctx.workspaceId)
  let chatCtx: Awaited<ReturnType<typeof startChat>> | undefined

  try {
    chatCtx = await startChat({
      chatId,
      messages: [userMessage],
      providerId: rootData.providerId,
      modelId: rootData.modelId,
      workspaceId,
      modeId: rootData.modeId ?? 'auto',
      tp: 'canvas',
      skipSnapshot: true,
    })

    const assistantMessage = await collectAssistantMessage(createUiStreamFromTextParts({
      originalMessages: chatCtx.normalizedMessages,
      messageId: chatCtx.assistantMessageId,
      parts: readPreparedTextStreamParts(chatCtx.preparedParts),
    }))
    await chatCtx.persistDone

    const cleanedAssistant = assistantMessage?.role === 'assistant'
      ? stripEchoedPrompt(assistantMessage, userPrompt)
      : undefined

    return extractTextFromMessage(cleanedAssistant)
  } finally {
    chatCtx?.finish()
  }
}

async function executeNodeByType(
  ctx: NodeExecutionContext,
  state: ExecutionState
): Promise<string> {
  switch (ctx.node.type) {
    case 'input':
      return executeInputNode(ctx)
    case 'ai':
      return executeAINode(ctx, state)
    case 'ai-session':
      return executeAISessionNode(ctx, state)
    default:
      throw new Error(`Unknown node type: ${(ctx.node as { type: string }).type}`)
  }
}

// ---- Channel & State ----

interface NodeChannel {
  nodeId: string
  pendingPredecessors: Set<string>
  receivedInputs: Map<string, string>
  status: 'pending' | 'ready' | 'running' | 'completed' | 'error'
  output?: string
  error?: Error
}

interface ExecutionState {
  runId: number
  workflow: CanvasWorkflow
  channels: Map<string, NodeChannel>
  predecessors: Map<string, Set<string>>
  successors: Map<string, Set<string>>
  runningTasks: Set<string>
  runningPromises: Map<string, Promise<void>>
  completedNodes: Set<string>
  leafNodes: Set<string>
  sessionParentIds: Set<string>
  nodeChatIds: Map<string, number>
  nodeSessionChatIds: Map<string, number>
}

// ---- Engine Functions ----

function initExecutionState(workflow: CanvasWorkflow, runId: number): ExecutionState {
  const channels = new Map<string, NodeChannel>()
  const predecessors = new Map<string, Set<string>>()
  const successors = new Map<string, Set<string>>()

  function addEdge(source: string, target: string): void {
    if (!successors.has(source)) successors.set(source, new Set())
    successors.get(source)!.add(target)
    if (!predecessors.has(target)) predecessors.set(target, new Set())
    predecessors.get(target)!.add(source)
  }

  for (const edge of workflow.edges) {
    addEdge(edge.source, edge.target)
  }

  const sessionChildCount = new Map<string, number>()
  for (const node of workflow.nodes) {
    if (node.type === 'ai-session') {
      const data = node.data as CanvasAISessionNodeData
      addEdge(data.parentNodeId, node.id)
      const count = (sessionChildCount.get(data.parentNodeId) ?? 0) + 1
      sessionChildCount.set(data.parentNodeId, count)
      if (count > 1) {
        throw new Error(`Node "${data.parentNodeId}" has multiple session children. Each node can only have one session continuation.`)
      }
    }
  }

  const sessionParentIds = collectSessionParentIds(workflow.nodes)
  const leafNodes = new Set<string>()

  for (const node of workflow.nodes) {
    const preds = predecessors.get(node.id) || new Set()
    channels.set(node.id, {
      nodeId: node.id,
      pendingPredecessors: new Set(preds),
      receivedInputs: new Map(),
      status: preds.size === 0 ? 'ready' : 'pending',
    })

    if (!successors.has(node.id) || successors.get(node.id)!.size === 0) {
      leafNodes.add(node.id)
    }
  }

  return {
    runId,
    workflow,
    channels,
    predecessors,
    successors,
    runningTasks: new Set(),
    runningPromises: new Map(),
    completedNodes: new Set(),
    leafNodes,
    sessionParentIds,
    nodeChatIds: new Map(),
    nodeSessionChatIds: new Map(),
  }
}

function getReadyNodes(state: ExecutionState): string[] {
  const ready: string[] = []
  for (const [nodeId, channel] of state.channels) {
    if (channel.status !== 'pending' && channel.status !== 'ready') continue
    if (channel.pendingPredecessors.size === 0 && !state.runningTasks.has(nodeId)) {
      channel.status = 'ready'
      ready.push(nodeId)
    }
  }
  return ready
}

function submitNode(
  nodeId: string,
  state: ExecutionState,
  storage: CombinedStorage
): void {
  const channel = state.channels.get(nodeId)!
  channel.status = 'running'
  state.runningTasks.add(nodeId)

  const promise = executeNode(nodeId, state, storage)
  state.runningPromises.set(nodeId, promise)
}

async function waitForAnyCompletion(state: ExecutionState): Promise<string> {
  const entries = Array.from(state.runningPromises.entries())
  const completedNodeId = await Promise.race(
    entries.map(async ([nodeId, promise]) => {
      await promise
      return nodeId
    })
  )
  return completedNodeId
}

function handleNodeCompletion(nodeId: string, state: ExecutionState): void {
  const channel = state.channels.get(nodeId)!
  state.runningTasks.delete(nodeId)
  state.runningPromises.delete(nodeId)
  state.completedNodes.add(nodeId)

  if (channel.status === 'completed' && channel.output !== undefined) {
    notifySuccessors(nodeId, channel.output, state)
  }
}

function notifySuccessors(nodeId: string, output: string, state: ExecutionState): void {
  const successorIds = state.successors.get(nodeId) || new Set()
  for (const successorId of successorIds) {
    const successorChannel = state.channels.get(successorId)!
    successorChannel.receivedInputs.set(nodeId, output)
    successorChannel.pendingPredecessors.delete(nodeId)
    if (successorChannel.pendingPredecessors.size === 0) {
      successorChannel.status = 'ready'
    }
  }
}

async function executeNode(
  nodeId: string,
  state: ExecutionState,
  storage: CombinedStorage
): Promise<void> {
  const channel = state.channels.get(nodeId)!
  const node = state.workflow.nodes.find(n => n.id === nodeId)!

  storage.updateCanvasNodeResult(state.runId, nodeId, {
    status: 'running',
    startedAt: Date.now(),
  })

  try {
    const cwd = resolveWorkspaceCwd(storage, state.workflow.workspaceId)
    const templateInputs = buildTemplateInputs(channel.receivedInputs, state.workflow.nodes)
    const ctx: NodeExecutionContext = {
      nodeId,
      node,
      runId: state.runId,
      workflowId: state.workflow.id,
      workspaceId: state.workflow.workspaceId,
      cwd,
      inputs: templateInputs,
    }

    const output = await executeNodeByType(ctx, state)

    channel.status = 'completed'
    channel.output = output

    storage.updateCanvasNodeResult(state.runId, nodeId, {
      status: 'success',
      output,
      finishedAt: Date.now(),
    })
  } catch (error) {
    channel.status = 'error'
    channel.error = error as Error

    storage.updateCanvasNodeResult(state.runId, nodeId, {
      status: 'error',
      error: (error as Error).message,
      finishedAt: Date.now(),
    })
  }
}

function allLeafNodesCompleted(state: ExecutionState): boolean {
  for (const leafId of state.leafNodes) {
    const channel = state.channels.get(leafId)!
    if (channel.status !== 'completed' && channel.status !== 'error') {
      return false
    }
  }
  return true
}

function collectLeafOutputs(state: ExecutionState): Record<string, string> {
  const outputs: Record<string, string> = {}
  for (const leafId of state.leafNodes) {
    const channel = state.channels.get(leafId)!
    if (channel.output !== undefined) {
      const node = state.workflow.nodes.find(n => n.id === leafId)!
      const nodeName = getNodeName(node, leafId)
      outputs[nodeName] = channel.output
    }
  }
  return outputs
}

async function disposeSharedAdapters(state: ExecutionState): Promise<void> {
  const sessionManager = getSessionManager()
  for (const sessionChatId of state.nodeSessionChatIds.values()) {
    await sessionManager.destroy(sessionChatId).catch(() => {})
  }
}

// ---- Public API ----

export async function executeCanvasWorkflow(
  workflow: CanvasWorkflow,
  runId: number,
  storage: CombinedStorage
): Promise<void> {
  const state = initExecutionState(workflow, runId)

  try {
    while (!allLeafNodesCompleted(state)) {
      const readyNodes = getReadyNodes(state)

      if (readyNodes.length > 0) {
        for (const nodeId of readyNodes) {
          submitNode(nodeId, state, storage)
        }
      }

      if (state.runningTasks.size === 0) {
        throw new Error('Workflow stalled: no nodes ready and none running')
      }

      const completedNodeId = await waitForAnyCompletion(state)
      handleNodeCompletion(completedNodeId, state)
    }

    const outputs = collectLeafOutputs(state)
    storage.updateCanvasRunStatus(runId, 'success', { outputs })
  } finally {
    await disposeSharedAdapters(state)
  }
}

export function startCanvasWorkflowExecution(
  storage: CombinedStorage,
  workflowId: number
): { runId: number } {
  const workflow = storage.getCanvasWorkflow(workflowId)
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`)

  const runId = storage.createCanvasRun(workflowId)

  // Run in background (fire-and-forget)
  executeCanvasWorkflow(workflow, runId, storage).catch((err) => {
    console.error(`[CanvasWorkflow] Execution failed: runId=${runId}`, err)
    storage.updateCanvasRunStatus(runId, 'error', { error: (err as Error).message })
  })

  return { runId }
}
