import type { UIMessage } from 'ai'
import { stripContextBlocks } from '@/lib/context-blocks'
import type { ExternalAgentTask } from '@/hooks/useExternalAgent'
import type { ExternalAgentResultMetadata } from '../components/ExternalAgentRenderer'
import { parseExternalAgentRun } from '@/hooks/useExternalAgent'
import {
  isExternalAgentResultMessage,
  parseExternalAgentResult,
} from '../components/ExternalAgentRenderer'
import {
  extractCompacted,
  extractContextUsage,
} from './chatMetadata'
import { getToolDisplayName, type ToolPartLike } from '../components/toolName'

export type TodoEntry = {
  id?: string
  content: string
  activeForm?: string
  status: string
}

export type RecentDerivedState = {
  firstUserTitle: string | null
  lastAssistant?: UIMessage
  compactedInfo: ReturnType<typeof extractCompacted>
  latestContextMetadata: ReturnType<typeof extractContextUsage>
  latestCodexMetadata: ReturnType<typeof extractContextUsage>
  latestTodos: TodoEntry[]
}

export type RecentDerivedSources = {
  initialized: boolean
  processedCount: number
  lastMessageId?: string
  lastMessageSignature: string
  contextMessageId?: string
  codexMessageId?: string
  todoMessageId?: string
}

export type ChatIndexState = {
  backgroundTaskIds: Set<string>
  externalAgentTasksById: Map<string, ExternalAgentTask>
  externalAgentNotificationsByTaskId: Map<string, ExternalAgentResultMetadata>
}

export type ChatIndexSources = {
  initialized: boolean
  processedCount: number
  lastMessageId?: string
  lastMessageSignature: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const getToolPartOutput = (part: UIMessage['parts'][number]): unknown => {
  if ('result' in part && part.result !== undefined) return part.result
  if ('output' in part) return part.output
  return undefined
}

export const parseBackgroundAgentTaskId = (value: unknown): string | null => {
  let record: Record<string, unknown> | null = null

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed)) record = parsed
    } catch {
      return null
    }
  } else if (isRecord(value)) {
    record = value
  }

  if (!record) return null
  if (record.status !== 'async_launched') return null
  return typeof record.task_id === 'string' && record.task_id.trim()
    ? record.task_id
    : null
}

export const createEmptyRecentDerivedState = (): RecentDerivedState => ({
  firstUserTitle: null,
  lastAssistant: undefined,
  compactedInfo: null,
  latestContextMetadata: null,
  latestCodexMetadata: null,
  latestTodos: [],
})

export const createEmptyRecentDerivedSources = (): RecentDerivedSources => ({
  initialized: false,
  processedCount: 0,
  lastMessageId: undefined,
  lastMessageSignature: 'empty',
  contextMessageId: undefined,
  codexMessageId: undefined,
  todoMessageId: undefined,
})

export const createEmptyChatIndexState = (): ChatIndexState => ({
  backgroundTaskIds: new Set<string>(),
  externalAgentTasksById: new Map<string, ExternalAgentTask>(),
  externalAgentNotificationsByTaskId: new Map<string, ExternalAgentResultMetadata>(),
})

export const createEmptyChatIndexSources = (): ChatIndexSources => ({
  initialized: false,
  processedCount: 0,
  lastMessageId: undefined,
  lastMessageSignature: 'empty',
})

export const getFirstUserTitleFromMessage = (message: UIMessage): string | null => {
  if (message.role !== 'user') return null
  const textPart = message.parts.find(
    (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> =>
      part.type === 'text' && part.text.trim().length > 0,
  )
  if (!textPart) return null
  // Title from what the user typed, not the quoted context in front of it.
  const typed = stripContextBlocks(textPart.text).replace(/\s+/g, ' ').trim()
  return typed ? typed.slice(0, 48) : null
}

const getTodoToolName = (part: UIMessage['parts'][number]) =>
  getToolDisplayName(part as ToolPartLike).toLowerCase().replace(/^tool-/, '')

const getToolPartInput = (part: UIMessage['parts'][number]): Record<string, unknown> => {
  const toolPart = part as ToolPartLike
  const input = toolPart.args ?? toolPart.input
  return isRecord(input) ? input : {}
}

const isTodoStatus = (value: unknown): value is 'pending' | 'in_progress' | 'completed' =>
  value === 'pending' || value === 'in_progress' || value === 'completed'

const hasTaskListSnapshot = (output: unknown, todos: TodoEntry[]) => {
  if (todos.length > 0) return true
  if (typeof output === 'string' && output.trim().toLowerCase() === 'no tasks found') return true

  let parsed = output
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output)
    } catch {
      return false
    }
  }
  return isRecord(parsed) && Array.isArray(parsed.tasks)
}

export type TodoMessageReduction = {
  changed: boolean
  todos: TodoEntry[]
}

/**
 * Apply one assistant message's task tools in stream order. TodoWrite,
 * TaskList and Codex plan steps are full snapshots; Claude TaskCreate and
 * TaskUpdate are incremental operations over the current task list.
 */
export const reduceTodosFromMessage = (
  currentTodos: TodoEntry[],
  message: UIMessage,
  isTodoWriteTool: (part: UIMessage['parts'][number]) => boolean,
  extractTodosFromPart: (part: UIMessage['parts'][number]) => TodoEntry[],
): TodoMessageReduction => {
  if (message.role !== 'assistant') return { changed: false, todos: currentTodos }

  let todos = currentTodos
  let changed = false

  for (const part of message.parts ?? []) {
    if (part.type !== 'dynamic-tool' && !(part.type as string).startsWith('tool-')) continue
    if (!isTodoWriteTool(part)) continue

    const toolName = getTodoToolName(part)
    const input = getToolPartInput(part)
    const extracted = extractTodosFromPart(part)

    if (toolName === 'todowrite') {
      if (!Array.isArray(input.todos)) continue
      todos = extracted
      changed = true
      continue
    }

    if (toolName === 'codex_plan_steps') {
      const output = getToolPartOutput(part)
      const source = isRecord(output) ? output : input
      if (!Array.isArray(source.steps)) continue
      todos = extracted
      changed = true
      continue
    }

    if (toolName === 'tasklist') {
      const output = getToolPartOutput(part)
      if (output === undefined || !hasTaskListSnapshot(output, extracted)) continue
      todos = extracted
      changed = true
      continue
    }

    if (toolName === 'taskcreate') {
      if (extracted.length === 0) continue
      todos = [...todos, ...extracted]
      changed = true
      continue
    }

    if (toolName === 'taskupdate') {
      const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
      if (!taskId) continue

      const taskIndex = todos.findIndex((todo) => todo.id === taskId)
      if (input.status === 'deleted') {
        if (taskIndex >= 0) {
          todos = todos.filter((_, index) => index !== taskIndex)
          changed = true
        }
        continue
      }

      if (taskIndex >= 0) {
        const current = todos[taskIndex]
        const next: TodoEntry = {
          ...current,
          ...(typeof input.subject === 'string' ? { content: input.subject } : {}),
          ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}),
          ...(isTodoStatus(input.status) ? { status: input.status } : {}),
        }
        todos = todos.map((todo, index) => index === taskIndex ? next : todo)
      } else if (extracted.length > 0) {
        todos = [...todos, ...extracted]
      }
      changed = true
      continue
    }

    if (toolName === 'taskget' && extracted.length > 0) {
      const task = extracted[0]
      const taskIndex = task.id ? todos.findIndex((todo) => todo.id === task.id) : -1
      todos = taskIndex >= 0
        ? todos.map((todo, index) => index === taskIndex ? task : todo)
        : [...todos, task]
      changed = true
    }
  }

  return { changed, todos }
}

export const extractLatestTodosFromMessage = (
  message: UIMessage,
  isTodoWriteTool: (part: UIMessage['parts'][number]) => boolean,
  extractTodosFromPart: (part: UIMessage['parts'][number]) => TodoEntry[],
): TodoEntry[] => reduceTodosFromMessage(
  [],
  message,
  isTodoWriteTool,
  extractTodosFromPart,
).todos

export const buildTodosState = (
  messages: UIMessage[],
  endIndex: number,
  isTodoWriteTool: (part: UIMessage['parts'][number]) => boolean,
  extractTodosFromPart: (part: UIMessage['parts'][number]) => TodoEntry[],
) => {
  let todos: TodoEntry[] = []
  let messageId: string | undefined

  for (let index = 0; index <= Math.min(endIndex, messages.length - 1); index += 1) {
    const message = messages[index]
    const reduction = reduceTodosFromMessage(todos, message, isTodoWriteTool, extractTodosFromPart)
    if (!reduction.changed) continue
    todos = reduction.todos
    messageId = message.id
  }

  return { todos, messageId }
}

export const findLatestContextMetadataBefore = (messages: UIMessage[], endIndex: number) => {
  for (let index = endIndex; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const metadata = extractContextUsage(message)
    if (metadata?.usage) {
      return { metadata, messageId: message.id }
    }
  }

  return { metadata: null, messageId: undefined }
}

export const findLatestCodexMetadataBefore = (messages: UIMessage[], endIndex: number) => {
  for (let index = endIndex; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const metadata = extractContextUsage(message)
    if (metadata?.codexAccount || metadata?.codexRateLimits) {
      return { metadata, messageId: message.id }
    }
  }

  return { metadata: null, messageId: undefined }
}

export const findLatestTodosBefore = (
  messages: UIMessage[],
  endIndex: number,
  isTodoWriteTool: (part: UIMessage['parts'][number]) => boolean,
  extractTodosFromPart: (part: UIMessage['parts'][number]) => TodoEntry[],
) => {
  return buildTodosState(messages, endIndex, isTodoWriteTool, extractTodosFromPart)
}

export const buildRecentDerivedState = (
  messages: UIMessage[],
  isTodoWriteTool: (part: UIMessage['parts'][number]) => boolean,
  extractTodosFromPart: (part: UIMessage['parts'][number]) => TodoEntry[],
) => {
  const state = createEmptyRecentDerivedState()
  const sources = createEmptyRecentDerivedSources()

  for (const message of messages) {
    if (!state.firstUserTitle) {
      const title = getFirstUserTitleFromMessage(message)
      if (title) state.firstUserTitle = title
    }

    const reduction = reduceTodosFromMessage(
      state.latestTodos,
      message,
      isTodoWriteTool,
      extractTodosFromPart,
    )
    if (reduction.changed) {
      state.latestTodos = reduction.todos
      sources.todoMessageId = message.id
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue

    if (!state.lastAssistant) {
      state.lastAssistant = message
      state.compactedInfo = extractCompacted(message)
    }

    if (!state.latestContextMetadata?.usage) {
      const metadata = extractContextUsage(message)
      if (metadata?.usage) {
        state.latestContextMetadata = metadata
        sources.contextMessageId = message.id
      }
    }

    if (!(state.latestCodexMetadata?.codexAccount || state.latestCodexMetadata?.codexRateLimits)) {
      const metadata = extractContextUsage(message)
      if (metadata?.codexAccount || metadata?.codexRateLimits) {
        state.latestCodexMetadata = metadata
        sources.codexMessageId = message.id
      }
    }

    if (
      state.lastAssistant &&
      state.latestContextMetadata?.usage &&
      (state.latestCodexMetadata?.codexAccount || state.latestCodexMetadata?.codexRateLimits)
    ) {
      break
    }
  }

  sources.initialized = true
  sources.processedCount = messages.length
  sources.lastMessageId = messages[messages.length - 1]?.id
  sources.lastMessageSignature = 'rebuilt'

  return { state, sources }
}

export const getRecentDerivedMessageSignature = (message: UIMessage | undefined): string => {
  if (!message) return 'empty'

  const metadata = extractContextUsage(message)
  const compacted = extractCompacted(message)

  return JSON.stringify({
    id: message.id,
    role: message.role,
    parts: (message.parts ?? []).map((part) => {
      if (part.type === 'text' || part.type === 'reasoning') {
        return `${part.type}:${part.text.length}`
      }
      if (part.type === 'dynamic-tool' || (part.type as string).startsWith('tool-')) {
        const toolPart = part as {
          state?: string
          result?: unknown
          output?: unknown
          toolName?: string
          name?: string
        }
        return `tool:${toolPart.toolName ?? toolPart.name ?? ''}:${toolPart.state ?? ''}:${toolPart.result !== undefined || toolPart.output !== undefined}`
      }
      return part.type
    }),
    metadata: {
      compacted: compacted ? 1 : 0,
      usage: metadata?.usage ? 1 : 0,
      promptTokens: metadata?.contextUsage?.promptTokens ?? null,
      contextWindow: metadata?.contextUsage?.contextWindow ?? null,
      codexAccount: metadata?.codexAccount ? 1 : 0,
      codexRateLimits: metadata?.codexRateLimits ? 1 : 0,
    },
  })
}

export const getChatIndexMessageSignature = (message: UIMessage | undefined): string => {
  if (!message) return 'empty'

  return JSON.stringify({
    id: message.id,
    role: message.role,
    parts: (message.parts ?? []).map((part) => {
      if (part.type === 'text') {
        return isExternalAgentResultMessage(part.text) ? `text:${part.text}` : `text-len:${part.text.length}`
      }
      if (part.type === 'dynamic-tool' || (part.type as string).startsWith('tool-')) {
        const output = getToolPartOutput(part)
        return {
          type: part.type,
          output: typeof output === 'string' ? output : JSON.stringify(output ?? null),
        }
      }
      return part.type
    }),
  })
}

export const applyMessageToChatIndex = (state: ChatIndexState, message: UIMessage) => {
  if (message.role === 'user') {
    for (const part of message.parts ?? []) {
      if (part.type !== 'text' || !isExternalAgentResultMessage(part.text)) continue
      const parsed = parseExternalAgentResult(part.text)
      if (parsed) {
        state.externalAgentNotificationsByTaskId.set(parsed.taskId, parsed)
      }
    }
    return
  }

  if (message.role !== 'assistant') return

  for (const part of message.parts ?? []) {
    const partType = typeof part.type === 'string' ? part.type : ''
    if (partType !== 'dynamic-tool' && !partType.startsWith('tool-')) continue

    const taskId = parseBackgroundAgentTaskId(getToolPartOutput(part))
    if (taskId) {
      state.backgroundTaskIds.add(taskId)
    }

    const externalTask = parseExternalAgentRun(part)
    if (externalTask) {
      state.externalAgentTasksById.set(externalTask.taskId, externalTask)
    }
  }
}

export const buildChatIndexState = (messages: UIMessage[]) => {
  const state = createEmptyChatIndexState()

  for (const message of messages) {
    applyMessageToChatIndex(state, message)
  }

  return {
    state,
    sources: {
      initialized: true,
      processedCount: messages.length,
      lastMessageId: messages[messages.length - 1]?.id,
      lastMessageSignature: 'rebuilt',
    },
  }
}
