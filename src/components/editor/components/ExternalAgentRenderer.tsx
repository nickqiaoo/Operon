import { ExternalLinkIcon } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { useEditorStore } from '@/stores/editor-store'
import { getTabInfoForTask } from '@/hooks/useExternalAgentBus'

/**
 * Check if a tool part is an external agent run tool.
 */
export function isExternalAgentTool(toolPart: { toolName?: string; name?: string }): boolean {
  const name = toolPart.toolName ?? toolPart.name ?? ''
  return (
    name === 'external_agent_run' ||
    name === 'mcp__external_agent__external_agent_run' ||
    name.endsWith('external_agent_run')
  )
}

export interface ExternalAgentResultMetadata {
  taskId: string
  agentType: string
  description: string
  childChatId: string
  dbChatId?: number
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
  const agentType = (args.agent_type as string) ?? 'agent'
  const description = (args.description as string) ?? ''

  const taskId = extractExternalAgentTaskId(toolPart)

  // Merge transient in-memory mapping with persisted completion metadata.
  // The dbChatId only exists in the persisted notification payload.
  const taskInfo = taskId ? getTabInfoForTask(taskId) : undefined

  const targetTabId = taskInfo?.tabId ?? notificationInfo?.childChatId
  const tabExists = targetTabId ? tabs.some((t) => t.id === targetTabId) : false
  const canClick = !!targetTabId

  const handleClick = () => {
    if (!targetTabId) return
    const dbChatId = notificationInfo?.dbChatId

    if (tabExists) {
      if (dbChatId !== undefined) {
        setTabChatId(targetTabId, dbChatId)
      }
      setActiveTab(targetTabId)
    } else {
      // Reopen from history
      const title = intl.formatMessage({ id: 'editor.external.tabTitle', defaultMessage: 'Agent: {desc}' }, { desc: taskInfo?.description ?? notificationInfo?.description ?? description })
      const providerId = taskInfo?.providerId ?? notificationInfo?.agentType ?? agentType
      openChatTab(targetTabId, title, undefined, providerId, true)
      if (dbChatId !== undefined) {
        setTabChatId(targetTabId, dbChatId)
      }
    }
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm ${canClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
      onClick={canClick ? handleClick : undefined}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ExternalLinkIcon className="size-3.5" />
        <span className="font-medium text-foreground">{agentType}</span>
        <span className="text-muted-foreground/70">-</span>
        <span>{description}</span>
      </div>
    </div>
  )
}

/**
 * Compact renderer for external agent result user messages.
 * Same card style as ExternalAgentToolRenderer, with a "completed" badge.
 */
export function ExternalAgentResultRenderer({ text }: { text: string }) {
  const intl = useIntl()
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const openChatTab = useEditorStore((s) => s.openChatTab)
  const setTabChatId = useEditorStore((s) => s.setTabChatId)
  const tabs = useEditorStore((s) => s.tabs)
  const parsed = parseExternalAgentResult(text)

  if (!parsed) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm">
        <ExternalLinkIcon className="size-3.5 text-green-600 dark:text-green-400" />
        <span className="text-muted-foreground"><FormattedMessage id="editor.external.completed" defaultMessage="Agent completed" /></span>
      </div>
    )
  }

  const tabExists = parsed.childChatId ? tabs.some((t) => t.id === parsed.childChatId) : false

  const handleClick = () => {
    if (!parsed.childChatId) return
    if (tabExists) {
      if (parsed.dbChatId !== undefined) {
        setTabChatId(parsed.childChatId, parsed.dbChatId)
      }
      setActiveTab(parsed.childChatId)
    } else {
      // Reopen tab and attach dbChatId so history loads
      openChatTab(parsed.childChatId, intl.formatMessage({ id: 'editor.external.tabTitle', defaultMessage: 'Agent: {desc}' }, { desc: parsed.description }), undefined, parsed.agentType, true)
      if (parsed.dbChatId !== undefined) {
        setTabChatId(parsed.childChatId, parsed.dbChatId)
      }
    }
  }

  return (
    <div
      className={`flex items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm ${parsed.childChatId ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
      onClick={parsed.childChatId ? handleClick : undefined}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ExternalLinkIcon className="size-3.5 text-green-600 dark:text-green-400" />
        <span className="font-medium text-foreground">{parsed.agentType}</span>
        <span className="text-muted-foreground/70">-</span>
        <span>{parsed.description}</span>
      </div>
      <span className="text-xs text-green-600 dark:text-green-400"><FormattedMessage id="editor.external.completedBadge" defaultMessage="Completed" /></span>
    </div>
  )
}
