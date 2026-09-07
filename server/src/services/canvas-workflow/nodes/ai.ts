import { randomUUID } from 'crypto'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type {
  CanvasAINodeData,
  CanvasAISessionNodeData,
  CanvasNode,
} from '../../../types/canvas-workflow.js'
import { validateValue } from 'operon-agents'
import { getSessionManager, startChat } from '../../ai.js'
import { readPreparedTextStreamParts } from '../../ai/prepared-stream-parts.js'
import { createUiStreamFromTextParts } from '../../ai/text-stream-part-to-ui.js'
import type { NodeExecutionContext, NodeExecutorDefinition } from '../types.js'

function createCanvasTextMessage(role: 'user' | 'assistant', content: string): UIMessage {
  return { id: randomUUID(), role, parts: [{ type: 'text', text: content }] }
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

function requireWorkspaceId(workspaceId?: number): number {
  if (workspaceId === undefined) {
    throw new Error('Canvas AI nodes require a workspace to use the unified chat flow')
  }
  return workspaceId
}

export function findRootAINode(nodeId: string, nodes: CanvasNode[]): CanvasNode {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error(`Node not found: ${nodeId}`)
  if (node.type === 'ai') return node
  if (node.type === 'ai-session') {
    const data = node.data as CanvasAISessionNodeData
    return findRootAINode(data.parentNodeId, nodes)
  }
  throw new Error(`Cannot find root AI node from node type: ${node.type}`)
}

export function collectSessionParentIds(nodes: CanvasNode[]): Set<string> {
  const rootIds = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'ai-session') {
      rootIds.add(findRootAINode(node.id, nodes).id)
    }
  }
  return rootIds
}

async function runTurn(
  chatCtx: Awaited<ReturnType<typeof startChat>>,
  userPrompt: string
): Promise<string> {
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
}

// ---- Structured output ----

const DEFAULT_SCHEMA_RETRIES = 2

type JsonSchema = Record<string, unknown>

function parseSchema(text: string | undefined): JsonSchema | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('ai failed: output schema is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ai failed: output schema must be a JSON object')
  }
  return parsed as JsonSchema
}

function schemaInstruction(schema: JsonSchema): string {
  return (
    'Respond with ONLY a single JSON value matching this JSON Schema. ' +
    `No prose, no explanation, no markdown fences:\n${JSON.stringify(schema)}`
  )
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

/** Parse + validate a reply; returns the canonical JSON or the reason it failed. */
function checkStructured(text: string, schema: JsonSchema): { ok: true; json: string } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return { ok: false, error: 'reply is not valid JSON' }
  }
  const verdict = validateValue(schema, parsed)
  if (!verdict.ok) return { ok: false, error: verdict.error }
  return { ok: true, json: JSON.stringify(parsed) }
}

async function executeAINode(ctx: NodeExecutionContext): Promise<string> {
  const data = ctx.node.data as CanvasAINodeData
  const schema = parseSchema(data.outputSchema)
  const basePrompt = ctx.render(data.userPrompt)
  const userPrompt = schema === undefined ? basePrompt : `${basePrompt}\n\n${schemaInstruction(schema)}`
  const workspaceId = requireWorkspaceId(ctx.workspaceId)
  const isShared = ctx.run.sessionParentIds.has(ctx.nodeId)
  let chatCtx: Awaited<ReturnType<typeof startChat>> | undefined
  let chatId: number | undefined

  const session = {
    providerId: data.providerId,
    modelId: data.modelId,
    workspaceId,
    modeId: data.modeId ?? 'auto',
    tp: 'canvas' as const,
    skipSnapshot: true,
  }

  try {
    chatCtx = await startChat({ ...session, messages: [createCanvasTextMessage('user', userPrompt)] })
    chatId = chatCtx.chatId
    ctx.run.nodeChatIds.set(ctx.nodeId, chatId)
    if (isShared) ctx.run.nodeSessionChatIds.set(ctx.nodeId, chatId)

    let reply = await runTurn(chatCtx, userPrompt)
    if (schema === undefined) return reply

    // Structured output: validate, and on failure continue the same chat with
    // a correction so the model sees what it wrote rather than starting over.
    const maxRetries = data.maxRetries ?? DEFAULT_SCHEMA_RETRIES
    let verdict = checkStructured(reply, schema)
    for (let attempt = 0; !verdict.ok && attempt < maxRetries; attempt++) {
      chatCtx.finish()
      const correction =
        `Your previous reply was invalid: ${verdict.error}. ` +
        `Return ONLY the corrected JSON matching the schema.`
      chatCtx = await startChat({ ...session, chatId, messages: [createCanvasTextMessage('user', correction)] })
      reply = await runTurn(chatCtx, correction)
      verdict = checkStructured(reply, schema)
    }
    if (!verdict.ok) {
      throw new Error(`ai failed: no schema-valid output after ${maxRetries + 1} attempts: ${verdict.error}`)
    }
    return verdict.json
  } finally {
    chatCtx?.finish()
    if (chatId !== undefined && !isShared) {
      await getSessionManager().destroy(chatId).catch(() => {})
    }
  }
}

async function executeAISessionNode(ctx: NodeExecutionContext): Promise<string> {
  const data = ctx.node.data as CanvasAISessionNodeData
  const rootNode = findRootAINode(data.parentNodeId, ctx.run.nodes)
  const rootData = rootNode.data as CanvasAINodeData

  const chatId = ctx.run.nodeChatIds.get(rootNode.id)
  if (chatId === undefined) {
    throw new Error(`No chat found for root node: ${rootNode.id}. Ensure the root AI node executed first.`)
  }

  const userPrompt = ctx.render(data.prompt)
  const workspaceId = requireWorkspaceId(ctx.workspaceId)
  let chatCtx: Awaited<ReturnType<typeof startChat>> | undefined

  try {
    chatCtx = await startChat({
      chatId,
      messages: [createCanvasTextMessage('user', userPrompt)],
      providerId: rootData.providerId,
      modelId: rootData.modelId,
      workspaceId,
      modeId: rootData.modeId ?? 'auto',
      tp: 'canvas',
      skipSnapshot: true,
    })
    return await runTurn(chatCtx, userPrompt)
  } finally {
    chatCtx?.finish()
  }
}

export const aiNode: NodeExecutorDefinition = { execute: executeAINode }
export const aiSessionNode: NodeExecutorDefinition = { execute: executeAISessionNode }
