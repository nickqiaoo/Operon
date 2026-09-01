import { REQUEST_NOT_HANDLED, type AppServerClient } from './sdk/app-server-client.js'
import type {
  AgentMessageDeltaNotification,
  CollabAgentToolCall,
  CommandExecution,
  CommandExecutionRequestApprovalNotification,
  CommandExecutionRequestApprovalResponse,
  FileChange,
  FileChangeRequestApprovalNotification,
  FileChangeRequestApprovalResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpToolCall,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnStartedNotification,
  TurnCompletedNotification,
  TurnError,
  WebSearch,
} from './sdk/protocol/index.js'
import type { PlanDeltaNotification, TurnPlanUpdatedNotification } from './sdk/protocol/notifications.js'
import type {
  CommandApprovalHandler,
  FileChangeApprovalHandler,
  ToolRequestUserInputHandler,
} from './sdk/types/settings.js'
import { safeJsonStringify } from './message-mapper.js'
import {
  CodexTextStreamEmitter,
  type CodexRateLimitSnapshot,
  type ThreadTokenUsage,
} from './text-stream-emitter.js'
import { ToolTracker, buildToolResultPayload, isToolItem, resolveToolName } from './tool-tracker.js'

type ToolItem = CommandExecution | FileChange | McpToolCall | WebSearch | CollabAgentToolCall
type AccountUpdatedPayload = { authMode: string | null; planType: string | null }
type AccountRateLimitsUpdatedPayload = { rateLimits: CodexRateLimitSnapshot | null }

export interface NotificationRouterOptions {
  threadId: string
  turnId: string
  onTurnCompleted: (status: string, error?: TurnError | null) => void
  onCommandApproval?: CommandApprovalHandler
  onFileChangeApproval?: FileChangeApprovalHandler
  onToolRequestUserInput?: ToolRequestUserInputHandler
}

interface SubAgentActivity {
  id: string
  type: 'thought' | 'tool_call'
  content: string
  displayName?: string
  description?: string
  args?: string
  output?: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
}

interface SubAgentTracking {
  agentName: string
  activities: SubAgentActivity[]
  finalStatus?: 'completed' | 'error'
}

interface ActiveSubTurn {
  threadId: string
  turnId: string
}

function extractItemOutput(item: { [key: string]: unknown }): string | undefined {
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) return item.aggregatedOutput
  if (item.result !== undefined && item.result !== null) {
    return typeof item.result === 'string' ? item.result : JSON.stringify(item.result)
  }
  if (item.error !== undefined && item.error !== null) {
    return typeof item.error === 'string' ? item.error : JSON.stringify(item.error)
  }
  return undefined
}

function itemToActivity(
  item: { type: string; id: string; [key: string]: unknown },
  status: 'running' | 'completed' | 'error',
): SubAgentActivity | null {
  const type = item.type.toLowerCase()
  switch (type) {
    case 'commandexecution':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'shell',
        displayName: 'Bash',
        description: typeof item.command === 'string' ? item.command : undefined,
        args: JSON.stringify({ command: item.command, cwd: item.cwd }),
        status,
      }
    case 'filechange':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'edit_file',
        displayName: 'Edit',
        description: Array.isArray(item.changes) && item.changes[0]
          ? String((item.changes[0] as Record<string, unknown>).path ?? '')
          : undefined,
        args: JSON.stringify({ changes: item.changes }),
        status,
      }
    case 'mcptoolcall':
      return {
        id: item.id,
        type: 'tool_call',
        content: `mcp__${item.server}__${item.tool}`,
        displayName: typeof item.tool === 'string' ? item.tool : 'MCP Tool',
        args: JSON.stringify({ server: item.server, tool: item.tool, arguments: item.arguments }),
        status,
      }
    case 'websearch':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'web_search',
        displayName: 'WebSearch',
        description: typeof item.query === 'string' ? item.query : undefined,
        args: JSON.stringify({ query: item.query }),
        status,
      }
    case 'dynamictoolcall':
      return {
        id: item.id,
        type: 'tool_call',
        content: typeof item.tool === 'string' ? item.tool : 'tool',
        displayName: typeof item.tool === 'string' ? item.tool : undefined,
        args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
        status,
      }
    default:
      return null
  }
}

export class NotificationRouter {
  private unsubscribers: Array<() => void> = []
  private toolTracker = new ToolTracker()
  private textItemIdsWithDelta = new Set<string>()
  private reasoningItemIdsWithDelta = new Set<string>()
  private emittedToolCallIds = new Set<string>()
  private subAgentTracker = new Map<string, SubAgentTracking>()
  private threadToCollabCall = new Map<string, string>()
  private activeSubTurns = new Map<string, string>()
  private planTextBuffer = ''
  private planApprovalEmitted = false

  constructor(
    private client: AppServerClient,
    private emitter: CodexTextStreamEmitter,
    private options: NotificationRouterOptions,
  ) {}

  private startTrackingCollabAgent(item: CollabAgentToolCall): void {
    const receiverThreadIds = item.receiverThreadIds
    if (!receiverThreadIds?.length) return
    this.subAgentTracker.set(item.id, {
      agentName: item.prompt ? item.prompt.slice(0, 80) : 'Agent',
      activities: [],
    })
    for (const threadId of receiverThreadIds) {
      this.threadToCollabCall.set(threadId, item.id)
    }
  }

  private emitSubAgentProgress(
    collabCallId: string,
    state: 'running' | 'completed' | 'error',
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId)
    if (!tracking) return
    this.emitter.emitToolResult(
      collabCallId,
      'codex_collab_agent',
      {
        isSubagentProgress: true,
        agentName: tracking.agentName,
        state,
        recentActivity: tracking.activities.map((activity) => ({ ...activity })),
      },
      false,
      true,
      state !== 'completed' && state !== 'error',
    )
  }

  private handleSubAgentItemStarted(
    collabCallId: string,
    item: { type: string; id: string; [key: string]: unknown },
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId)
    if (!tracking) return
    const activity = itemToActivity(item, 'running')
    if (!activity) return
    tracking.activities.push(activity)
    this.emitSubAgentProgress(collabCallId, 'running')
  }

  private handleSubAgentItemCompleted(
    collabCallId: string,
    item: { type: string; id: string; [key: string]: unknown },
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId)
    if (!tracking) return
    const output = extractItemOutput(item)
    const hasError = 'exitCode' in item && item.exitCode !== 0 && item.exitCode !== null
    const existing = tracking.activities.find((activity) => activity.id === item.id)
    if (existing) {
      existing.status = hasError ? 'error' : 'completed'
      if (output) existing.output = output
    } else {
      const activity = itemToActivity(item, 'completed')
      if (activity) {
        if (output) activity.output = output
        tracking.activities.push(activity)
      }
    }
    this.emitSubAgentProgress(collabCallId, 'running')
  }

  private rememberActiveSubTurn(threadId: string, turnId: string): void {
    this.activeSubTurns.set(String(threadId), String(turnId))
  }

  private clearActiveSubTurn(threadId: string): void {
    this.activeSubTurns.delete(String(threadId))
  }

  getActiveSubTurns(): ActiveSubTurn[] {
    return Array.from(this.activeSubTurns.entries()).map(([threadId, turnId]) => ({ threadId, turnId }))
  }

  subscribe(): void {
    const { threadId, turnId } = this.options
    const sameThread = (left: string, right: string) => String(left) === String(right)
    const sameTurn = (left: string, right: string) => String(left) === String(right)
    const normalizeType = (type: string) => type.toLowerCase()
    const isAgentMessage = (item: { type: string }): item is { type: string; id: string; text: string } =>
      normalizeType(item.type) === 'agentmessage'
    const isReasoning = (
      item: { type: string },
    ): item is { type: string; id: string; summary: string[] | string; content: string[] | string } =>
      normalizeType(item.type) === 'reasoning'
    const isPlanItem = (item: { type: string }): item is { type: string; id: string; text: string } =>
      normalizeType(item.type) === 'plan'
    const isContextCompaction = (item: { type: string }): item is { type: 'contextCompaction'; id: string } =>
      item.type === 'contextCompaction'

    const emitPlanApprovalIfNeeded = () => {
      if (this.planApprovalEmitted || !this.planTextBuffer) return
      this.planApprovalEmitted = true
      const planApprovalId = `plan-approval-${turnId}`
      this.emitter.flushText()
      this.emitter.flushReasoning()
      this.emitter.emitToolInput(planApprovalId, 'ExitPlanMode', '{}', true)
      this.emitter.emitToolCall(planApprovalId, 'ExitPlanMode', '{}', true)
      this.emittedToolCallIds.add(planApprovalId)
      this.emitter.emitApprovalRequest(planApprovalId)
    }

    const handleTextDelta = (params: unknown) => {
      const payload = params as AgentMessageDeltaNotification['params']
      if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
      this.textItemIdsWithDelta.add(String(payload.itemId))
      this.emitter.emitTextDelta(payload.delta)
    }

    const handleReasoningDelta = (params: unknown, isSummary: boolean) => {
      const payload =
        params as ReasoningTextDeltaNotification['params'] | ReasoningSummaryTextDeltaNotification['params']
      if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
      this.reasoningItemIdsWithDelta.add(String(payload.itemId))
      const delta = 'delta' in payload ? payload.delta : ''
      this.emitter.emitReasoningDelta(delta, isSummary)
    }

    this.unsubscribers.push(
      this.client.onNotification('item/agentMessage/delta', handleTextDelta),
      this.client.onNotification('agentMessageDelta', handleTextDelta),
      this.client.onNotification('reasoningTextDelta', (params) => handleReasoningDelta(params, false)),
      this.client.onNotification('reasoningSummaryTextDelta', (params) => handleReasoningDelta(params, true)),
      this.client.onNotification('item/reasoning/textDelta', (params) => handleReasoningDelta(params, false)),
      this.client.onNotification('item/reasoning/summaryTextDelta', (params) => handleReasoningDelta(params, true)),
    )

    this.unsubscribers.push(
      this.client.onNotification('turn/started', (params) => {
        const payload = params as TurnStartedNotification['params']
        const collabCallId = this.threadToCollabCall.get(String(payload.threadId))
        if (!collabCallId) return
        this.rememberActiveSubTurn(payload.threadId, String(payload.turn.id))
      }),
    )

    this.unsubscribers.push(
      this.client.onNotification('item/started', (params) => {
        const payload = params as ItemStartedNotification['params']
        const collabCallId = this.threadToCollabCall.get(String(payload.threadId))
        if (collabCallId) {
          this.rememberActiveSubTurn(payload.threadId, payload.turnId)
          const rawItem = payload.item as unknown as { type: string; id: string; [key: string]: unknown }
          this.handleSubAgentItemStarted(collabCallId, rawItem)
          return
        }
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
        if (isContextCompaction(payload.item)) {
          this.emitter.emitContextCompactionStarted(payload.item.id)
          return
        }
        if (!isToolItem(payload.item)) return

        const item = payload.item as ToolItem
        const info = this.toolTracker.start(item)
        this.emitter.flushText()
        this.emitter.flushReasoning()
        this.emitter.emitToolInput(item.id, info.toolName, info.input, info.dynamic)
        this.emitter.emitToolCall(item.id, info.toolName, info.input, info.dynamic)
        this.emittedToolCallIds.add(item.id)

        if (normalizeType(item.type) === 'collabagenttoolcall') {
          this.startTrackingCollabAgent(item as CollabAgentToolCall)
        }
      }),
    )

    this.unsubscribers.push(
      this.client.onNotification('item/completed', (params) => {
        const payload = params as ItemCompletedNotification['params']
        const collabCallId = this.threadToCollabCall.get(String(payload.threadId))
        if (collabCallId) {
          this.rememberActiveSubTurn(payload.threadId, payload.turnId)
          const rawItem = payload.item as unknown as { type: string; id: string; [key: string]: unknown }
          this.handleSubAgentItemCompleted(collabCallId, rawItem)
          return
        }

        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
        if (isContextCompaction(payload.item)) {
          this.emitter.emitContextCompactionCompleted(payload.item.id)
          return
        }
        if (isToolItem(payload.item)) {
          const item = payload.item as ToolItem
          const existing = this.toolTracker.complete(item.id)
          const resolved = existing ?? resolveToolName(item)
          const toolName = resolved.toolName
          const dynamic = resolved.dynamic
          const itemType = normalizeType(item.type)
          const durationMs = 'durationMs' in item ? (item.durationMs ?? undefined) : undefined

          if (itemType === 'commandexecution') this.emitter.recordToolExecution('command', durationMs)
          else if (itemType === 'filechange') this.emitter.recordToolExecution('fileChange')
          else if (itemType === 'mcptoolcall') this.emitter.recordToolExecution('mcpTool', durationMs)
          else if (itemType === 'websearch') this.emitter.recordToolExecution('webSearch')
          else if (itemType === 'collabagenttoolcall') {
            this.emitter.recordToolExecution('collabAgent', durationMs)
            if (!this.subAgentTracker.has(item.id)) {
              this.startTrackingCollabAgent(item as CollabAgentToolCall)
            }
            const tracking = this.subAgentTracker.get(item.id)
            if (tracking) {
              tracking.finalStatus = (item as CollabAgentToolCall).status === 'failed' ? 'error' : 'completed'
              if (tracking.activities.length > 0) {
                for (const activity of tracking.activities) {
                  if (activity.status === 'running') activity.status = 'completed'
                }
                this.emitSubAgentProgress(item.id, 'running')
              }
              return
            }
          }

          const { result, isError } = buildToolResultPayload(item)
          this.emitter.emitToolResult(item.id, toolName, result, isError, dynamic)
          return
        }

        if (isAgentMessage(payload.item)) {
          const itemId = String(payload.item.id)
          if (!this.textItemIdsWithDelta.has(itemId) && payload.item.text) {
            this.emitter.emitTextDelta(payload.item.text)
          }
          return
        }

        if (isReasoning(payload.item)) {
          const itemId = String(payload.item.id)
          if (!this.reasoningItemIdsWithDelta.has(itemId)) {
            const summary = Array.isArray(payload.item.summary) ? payload.item.summary.join('\n') : payload.item.summary
            const content = Array.isArray(payload.item.content) ? payload.item.content.join('\n') : payload.item.content
            if (summary) this.emitter.emitReasoningDelta(summary, true)
            if (content) this.emitter.emitReasoningDelta(content, false)
          }
          return
        }

        if (isPlanItem(payload.item)) {
          const itemId = String(payload.item.id)
          if (!this.textItemIdsWithDelta.has(itemId) && payload.item.text) {
            this.emitter.emitTextDelta(payload.item.text)
          }
          emitPlanApprovalIfNeeded()
        }
      }),
    )

    this.unsubscribers.push(
      this.client.onRequest('item/commandExecution/requestApproval', async (params): Promise<CommandExecutionRequestApprovalResponse | typeof REQUEST_NOT_HANDLED> => {
        const payload = params as CommandExecutionRequestApprovalNotification['params']
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) {
          return REQUEST_NOT_HANDLED
        }
        {
          if (!this.emittedToolCallIds.has(payload.itemId)) {
            const toolInput = safeJsonStringify({ command: payload.command, cwd: payload.cwd })
            this.emitter.flushText()
            this.emitter.flushReasoning()
            this.emitter.emitToolInput(payload.itemId, 'exec', toolInput, true)
            this.emitter.emitToolCall(payload.itemId, 'exec', toolInput, true)
            this.emittedToolCallIds.add(payload.itemId)
          }
          this.emitter.emitApprovalRequest(payload.itemId)
        }
        if (this.options.onCommandApproval) return this.options.onCommandApproval(payload)
        return { decision: 'decline' }
      }),
      this.client.onRequest('item/fileChange/requestApproval', async (params): Promise<FileChangeRequestApprovalResponse | typeof REQUEST_NOT_HANDLED> => {
        const payload = params as FileChangeRequestApprovalNotification['params']
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) {
          return REQUEST_NOT_HANDLED
        }
        {
          if (!this.emittedToolCallIds.has(payload.itemId)) {
            const toolInput = safeJsonStringify({ changes: payload.changes })
            this.emitter.flushText()
            this.emitter.flushReasoning()
            this.emitter.emitToolInput(payload.itemId, 'patch', toolInput, true)
            this.emitter.emitToolCall(payload.itemId, 'patch', toolInput, true)
            this.emittedToolCallIds.add(payload.itemId)
          }
          this.emitter.emitApprovalRequest(payload.itemId)
        }
        if (this.options.onFileChangeApproval) return this.options.onFileChangeApproval(payload)
        return { decision: 'decline' }
      }),
      this.client.onRequest('item/tool/requestUserInput', async (params): Promise<ToolRequestUserInputResponse | typeof REQUEST_NOT_HANDLED> => {
        const payload = params as ToolRequestUserInputParams
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) {
          return REQUEST_NOT_HANDLED
        }
        {
          const questions = payload.questions.map((question) => ({
            id: question.id,
            question: question.question,
            header: question.header,
            options: (question.options ?? []).map((option) => ({
              label: option.label,
              description: option.description,
            })),
            multiSelect: false,
            isSecret: question.isSecret,
          }))
          const toolInput = JSON.stringify({ questions })
          this.emitter.flushText()
          this.emitter.flushReasoning()
          this.emitter.emitToolInput(payload.itemId, 'AskUserQuestion', toolInput, true)
          this.emitter.emitToolCall(payload.itemId, 'AskUserQuestion', toolInput, true)
          this.emittedToolCallIds.add(payload.itemId)
          this.emitter.emitApprovalRequest(payload.itemId)
        }

        const response = this.options.onToolRequestUserInput
          ? await this.options.onToolRequestUserInput(payload)
          : { answers: {} }

        if (sameThread(payload.threadId, threadId) && sameTurn(payload.turnId, turnId)) {
          this.emitter.emitToolResult(
            payload.itemId,
            'AskUserQuestion',
            { answers: response.answers } as Record<string, unknown>,
            false,
            true,
          )
        }
        return response
      }),
    )

    this.unsubscribers.push(
      this.client.onNotification('item/plan/delta', (params) => {
        const payload = params as PlanDeltaNotification['params']
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
        this.textItemIdsWithDelta.add(String(payload.itemId))
        this.emitter.emitTextDelta(payload.delta)
        this.planTextBuffer += payload.delta
      }),
    )

    const planStepToolId = `plan-steps-${turnId}`
    let planStepToolEmitted = false
    this.unsubscribers.push(
      this.client.onNotification('turn/plan/updated', (params) => {
        const payload = params as TurnPlanUpdatedNotification['params']
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
        const input = JSON.stringify({ steps: payload.plan, explanation: payload.explanation })
        if (!planStepToolEmitted) {
          planStepToolEmitted = true
          this.emitter.flushText()
          this.emitter.flushReasoning()
          this.emitter.emitToolInput(planStepToolId, 'codex_plan_steps', input, true)
          this.emitter.emitToolCall(planStepToolId, 'codex_plan_steps', input, true)
          this.emittedToolCallIds.add(planStepToolId)
        }
        this.emitter.emitToolResult(
          planStepToolId,
          'codex_plan_steps',
          { steps: payload.plan, explanation: payload.explanation },
          false,
          true,
        )
        emitPlanApprovalIfNeeded()
      }),
      this.client.onNotification('thread/tokenUsage/updated', (params) => {
        const payload = params as { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage }
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turnId, turnId)) return
        this.emitter.updateTokenUsage(payload.tokenUsage)
      }),
      this.client.onNotification('account/updated', (params) => {
        const payload = params as AccountUpdatedPayload
        this.emitter.updateAccountSummary({ authMode: payload.authMode, planType: payload.planType })
      }),
      this.client.onNotification('account/rateLimits/updated', (params) => {
        const payload = params as AccountRateLimitsUpdatedPayload
        this.emitter.updateRateLimitSnapshot(payload.rateLimits)
      }),
      this.client.onNotification('turn/completed', (params) => {
        const payload = params as TurnCompletedNotification['params']
        const subThreadCollabId = this.threadToCollabCall.get(String(payload.threadId))
        if (subThreadCollabId) {
          this.clearActiveSubTurn(payload.threadId)
          const tracking = this.subAgentTracker.get(subThreadCollabId)
          if (tracking) {
            for (const activity of tracking.activities) {
              if (activity.status === 'running') activity.status = 'completed'
            }
            this.emitSubAgentProgress(subThreadCollabId, tracking.finalStatus ?? 'completed')
          }
          return
        }
        if (!sameThread(payload.threadId, threadId) || !sameTurn(payload.turn.id, turnId)) return
        for (const [collabCallId, tracking] of this.subAgentTracker) {
          if (tracking.activities.length === 0) continue
          for (const activity of tracking.activities) {
            if (activity.status === 'running') activity.status = 'completed'
          }
          this.emitSubAgentProgress(collabCallId, tracking.finalStatus ?? 'completed')
        }
        this.textItemIdsWithDelta.clear()
        this.reasoningItemIdsWithDelta.clear()
        this.options.onTurnCompleted(payload.turn.status, payload.turn.error)
      }),
    )
  }

  unsubscribe(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe()
    }
    this.unsubscribers = []
  }
}
