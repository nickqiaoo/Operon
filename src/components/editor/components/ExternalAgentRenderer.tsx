import { useState } from 'react'
import { CircleAlert, ExternalLinkIcon, Loader2 } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { needsConversationToAnswer, type PendingInputSummary } from '@shared/pending-input'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'
import { useEditorStore } from '@/stores/editor-store'
import { useExternalAgentsStore } from '@/stores/external-agents-store'
import { parseExternalAgentRun } from '@/hooks/useExternalAgent'
import type { UIMessage } from 'ai'

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
  const agentId = parsed?.agentId ?? (typeof args.agent_id === 'string' ? args.agent_id : undefined)
  const live = useExternalAgentsStore((s) => agentId ? s.agents.get(agentId) : undefined)
  const agentType = live?.providerId ?? parsed?.agentType ?? (args.agent_type as string) ?? 'agent'
  const description = live?.description ?? parsed?.description ?? (args.description as string) ?? ''

  const childId = live?.childChatId ?? parsed?.childChatId
  const pending = useChatPendingInputStore((s) => (childId != null ? s.pendingByChat.get(childId) : undefined))
  const targetTabId = childId ? `chat:${childId}` : notificationInfo?.childChatId
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
      const title = intl.formatMessage({ id: 'editor.external.tabTitle', defaultMessage: 'Agent: {desc}' }, { desc: notificationInfo?.description ?? description })
      const providerId = notificationInfo?.agentType ?? agentType
      openChatTab(targetTabId, title, undefined, providerId, true)
      if (dbChatId !== undefined) {
        setTabChatId(targetTabId, dbChatId)
      }
    }
  }

  return (
    <div
      className={`rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm ${canClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
      onClick={canClick ? handleClick : undefined}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ExternalLinkIcon className="size-3.5" />
        <span className="font-medium text-foreground">{agentType}</span>
        <span className="text-muted-foreground/70">-</span>
        <span>{description}</span>
        {childId != null && pending?.length ? (
          <span className="text-xs text-status-warn">
            <FormattedMessage id="editor.external.waitingForYou" defaultMessage="waiting for you" />
          </span>
        ) : live ? (
          <span className="text-xs text-muted-foreground">{live.status}</span>
        ) : null}
      </div>
      {childId != null && pending?.length ? (
        <ExternalAgentPendingInput childChatId={childId} pending={pending} onOpen={handleClick} />
      ) : null}
    </div>
  )
}

/**
 * What the child chat is blocked on, answerable from the parent.
 *
 * The child usually runs in a background tab, so without this the parent just
 * shows "running" while nothing happens. A plain approval is answered here, with
 * the request's own preview so it is not approved blind; a question or a plan
 * needs the child's own UI, so those only offer to open it. Answers go through
 * the same permission response as the child tab and the inbox, and the
 * live-status stream clears every surface once one of them answers.
 */
function ExternalAgentPendingInput({
  childChatId,
  pending,
  onOpen,
}: {
  childChatId: number
  pending: PendingInputSummary[]
  onOpen: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const decide = async (approvalId: string, outcome: 'allow' | 'deny') => {
    setBusyId(approvalId)
    try {
      const res = await api.aiPermissionResponse({ id: approvalId, outcome, chatId: childChatId })
      if (!res.success) {
        // Stale (answered elsewhere, or timed out): take the server's word for what is left.
        const fresh = await api.aiPendingApprovals(childChatId)
        useChatPendingInputStore.getState().set(childChatId, (fresh.approvals ?? []).map((a) => ({ userFacing: true, ...a })))
      }
    } catch (error) {
      console.warn('[external-agent] permission response failed', error)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-border/40 pt-2" onClick={(event) => event.stopPropagation()}>
      {pending.map((item) => (
        <div key={item.approvalId} className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-foreground">
              {item.toolName === 'AskUserQuestion' ? (
                <FormattedMessage id="editor.external.pendingQuestion" defaultMessage="The agent asked you a question" />
              ) : needsConversationToAnswer(item) ? (
                <FormattedMessage id="editor.external.pendingPlan" defaultMessage="The agent proposed a plan for review" />
              ) : (
                <FormattedMessage
                  id="editor.external.pendingApproval"
                  defaultMessage="Approval requested · {tool}"
                  values={{ tool: <span className="font-mono text-muted-foreground">{item.toolName}</span> }}
                />
              )}
            </div>
            {item.inputPreview && !needsConversationToAnswer(item) ? (
              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={item.inputPreview}>
                {item.inputPreview}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {needsConversationToAnswer(item) ? (
              <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={onOpen}>
                <ExternalLinkIcon className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.external.openToAnswer" defaultMessage="Open" />
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={busyId === item.approvalId}
                  onClick={() => void decide(item.approvalId, 'deny')}
                >
                  <FormattedMessage id="editor.external.deny" defaultMessage="Deny" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 gap-1.5 text-xs"
                  disabled={busyId === item.approvalId}
                  onClick={() => void decide(item.approvalId, 'allow')}
                >
                  {busyId === item.approvalId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  <FormattedMessage id="editor.external.allow" defaultMessage="Allow" />
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
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
      <span className="text-xs text-muted-foreground">{parsed.status ?? 'completed'}</span>
    </div>
  )
}
