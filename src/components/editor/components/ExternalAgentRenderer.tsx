import { ChevronRightIcon } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'
import { useEditorStore } from '@/stores/editor-store'
import { useExternalAgentsStore } from '@/stores/external-agents-store'
import { matchExternalAgentRun, parseExternalAgentRun } from '@/hooks/useExternalAgent'
import { useChatDbId } from './chat-db-id-context'
import { openChildChat, useOtherWorkspaceName } from '@/hooks/useChatChildren'
import type { UIMessage } from 'ai'
import type { ActivityStatus } from '@shared/assistant'
import { codingAgentName } from '@/components/assistant/CodingAgentCard'
import { ACTIVITY_STATUS_MESSAGES } from '@/components/assistant/assistant-i18n'
import { ProviderIcon } from './ModelSelectorPanel'
import { ChildPendingInput } from './ChildPendingInput'

/**
 * Check if a tool part is an external agent run tool.
 */
export function isExternalAgentTool(toolPart: { toolName?: string; name?: string }): boolean {
  const name = toolPart.toolName ?? toolPart.name ?? ''
  return (
    name === 'external_agent_run' ||
    name === 'mcp__external_agent__external_agent_run' ||
    name.endsWith('external_agent_run') || name.endsWith('external_agent_send')
  )
}

export interface ExternalAgentResultMetadata {
  taskId: string
  agentType: string
  description: string
  childChatId: string
  dbChatId?: number
  status?: string
  agentId?: string
}

/**
 * Check if a user message is an external agent result notification.
 */
export function isExternalAgentResultMessage(text: string): boolean {
  return text.includes('<external-agent-result>')
}

/**
 * Parse external agent result metadata from the notification message.
 */
export function parseExternalAgentResult(text: string): ExternalAgentResultMetadata | null {
  const taskIdMatch = text.match(/<task-id>(.*?)<\/task-id>/)
  const agentTypeMatch = text.match(/<agent-type>(.*?)<\/agent-type>/)
  const descriptionMatch = text.match(/<description>(.*?)<\/description>/)
  const childChatIdMatch = text.match(/<child-chat-id>(.*?)<\/child-chat-id>/)

  if (!taskIdMatch || !agentTypeMatch || !descriptionMatch || !childChatIdMatch) return null

  const dbChatIdMatch = text.match(/<db-chat-id>(\d+)<\/db-chat-id>/)

  return {
    taskId: taskIdMatch[1],
    status: text.match(/<status>(.*?)<\/status>/)?.[1],
    agentId: text.match(/<agent-id>(.*?)<\/agent-id>/)?.[1],
    agentType: agentTypeMatch[1],
    description: descriptionMatch[1],
    childChatId: childChatIdMatch[1],
    dbChatId: dbChatIdMatch ? parseInt(dbChatIdMatch[1], 10) : undefined,
  }
}

/**
 * Extract task_id from the tool output (handles nested adapter formats).
 */
export function extractExternalAgentTaskId(toolPart: { result?: unknown; output?: unknown }): string | undefined {
  const raw = toolPart.result ?? toolPart.output
  if (!raw) return undefined

  const tryParse = (value: unknown): Record<string, unknown> | null => {
    if (!value) return null
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>
      } catch {
        return null
      }
    }
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>
    }
    return null
  }

  const dig = (obj: Record<string, unknown>, depth: number): string | undefined => {
    if (depth > 5) return undefined
    if (typeof obj.task_id === 'string') return obj.task_id

    for (const key of ['result', 'output', 'response', 'content', 'text'] as const) {
      const value = obj[key]
      if (typeof value === 'string') {
        const inner = tryParse(value)
        if (inner) {
          const found = dig(inner, depth + 1)
          if (found) return found
        }
        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item !== 'object' || item === null) continue
          const found = dig(item as Record<string, unknown>, depth + 1)
          if (found) return found
        }
        continue
      }

      if (typeof value === 'object' && value !== null) {
        const found = dig(value as Record<string, unknown>, depth + 1)
        if (found) return found
      }
    }

    return undefined
  }

  const parsed = tryParse(raw)
  return parsed ? dig(parsed, 0) : undefined
}

export function ExternalAgentToolRenderer({
  toolPart,
  notificationInfo,
}: {
  toolPart: { args?: Record<string, unknown>; input?: Record<string, unknown>; result?: unknown; output?: unknown }
  notificationInfo?: ExternalAgentResultMetadata
}) {
  const intl = useIntl()
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const openChatTab = useEditorStore((s) => s.openChatTab)
  const setTabChatId = useEditorStore((s) => s.setTabChatId)
  const tabs = useEditorStore((s) => s.tabs)
  const rawArgs = (toolPart.args ?? toolPart.input ?? {}) as Record<string, unknown>
  // MCP dynamic tools wrap actual args in "arguments", direct tools have them at top level
  const args = (rawArgs.arguments as Record<string, unknown>) ?? rawArgs
  const parsed = parseExternalAgentRun({ ...toolPart, type: 'dynamic-tool', toolName: 'external_agent_run' } as UIMessage['parts'][number])
  const parentChatId = useChatDbId()
  const ownId = parsed?.agentId ?? (typeof args.agent_id === 'string' ? args.agent_id : undefined)
  // A call nested in a Code Mode program has an empty output; find its agent by what it asked for.
  const matchedId = useExternalAgentsStore((s) =>
    ownId ? undefined : matchExternalAgentRun(s.agents.values(), parentChatId, { agentType: args.agent_type, description: args.description }))
  const agentId = ownId ?? matchedId
  const live = useExternalAgentsStore((s) => agentId ? s.agents.get(agentId) : undefined)
  const agentType = live?.providerId ?? parsed?.agentType ?? (args.agent_type as string) ?? 'agent'
  const description = live?.description ?? parsed?.description ?? (args.description as string) ?? ''

  const childId = live?.childChatId ?? parsed?.childChatId
  const pending = useChatPendingInputStore((s) => (childId != null ? s.pendingByChat.get(childId) : undefined))
  const targetTabId = childId ? `chat:${childId}` : notificationInfo?.childChatId
  const tabExists = targetTabId ? tabs.some((t) => t.id === targetTabId) : false
  const canClick = !!targetTabId

  const handleClick = () => {
    // The usual case now that children don't open a tab when they start: open it
    // with the child's own model and mode.
    if (live) {
      void openChildChat({ childChatId: live.childChatId, title: description, providerId: live.providerId, modelId: live.modelId, modeId: live.modeId, workspaceId: live.workspaceId })
      return
    }
    if (!targetTabId) return
    const dbChatId = notificationInfo?.dbChatId

    if (tabExists) {
      if (dbChatId !== undefined) {
        setTabChatId(targetTabId, dbChatId)
      }
      setActiveTab(targetTabId)
    } else {
      // Reopen from history
      const title = intl.formatMessage({ id: 'editor.external.tabTitle', defaultMessage: 'Agent: {desc}' }, { desc: notificationInfo?.description ?? description })
      const providerId = notificationInfo?.agentType ?? agentType
      openChatTab(targetTabId, title, undefined, providerId, true)
      if (dbChatId !== undefined) {
        setTabChatId(targetTabId, dbChatId)
      }
    }
  }

  const waiting = childId != null && !!pending?.length
  const status = waiting ? 'waiting' : activityStatusOf(live?.status)
  const chosenModel = live?.modelId ?? parsed?.model ?? (typeof args.model === 'string' ? args.model : undefined)
  const model = chosenModel && chosenModel !== 'default' ? chosenModel : undefined
  const workspace = useOtherWorkspaceName(live?.workspaceId)
  const error = live?.status === 'failed' ? live.error : undefined
  const openLabel = intl.formatMessage({ id: 'assistant.coding.openConversation', defaultMessage: 'Open conversation' })

  // The run as a Subagent line: who and what, on which model, and its state;
  // the line opens the child conversation. Whatever the child is blocked on
  // sits under it as Items, like any other question for the person.
  const line = (
    <TraceLine status={status === 'running' ? 'running' : status === 'failed' ? 'error' : undefined}>
      <TraceIcon><ProviderIcon id={agentType} size={16} /></TraceIcon>
      <TraceTitle>{description || codingAgentName(agentType)}</TraceTitle>
      <TraceDescription className="min-w-0 shrink truncate">
        {[codingAgentName(agentType), model, workspace].filter(Boolean).join(' · ')}
      </TraceDescription>
      {status && status !== 'running' && (
        <TraceDescription className={status === 'waiting' ? 'text-status-warn' : undefined}>
          <FormattedMessage {...ACTIVITY_STATUS_MESSAGES[status]} />
        </TraceDescription>
      )}
      {canClick && <TraceIcon><ChevronRightIcon /></TraceIcon>}
    </TraceLine>
  )

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Trace>
        {canClick ? (
          <button type="button" onClick={handleClick} aria-label={openLabel} title={openLabel}>
            {line}
          </button>
        ) : (
          line
        )}
      </Trace>
      {error && <div className="line-clamp-2 pl-6 text-xs text-status-error">{error}</div>}
      {waiting ? (
        <ChildPendingInput childChatId={childId} pending={pending} onOpen={handleClick} />
      ) : null}
    </div>
  )
}

/** The child's turn state in the assistant's vocabulary, so both cards read the same. */
function activityStatusOf(status: string | undefined): ActivityStatus | null {
  switch (status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'interrupted':
      return 'stopped'
    default:
      return null
  }
}
