import { randomUUID } from 'crypto'
import type { ModelMessage } from 'ai'
import type { AgentInput, ApprovalResponse, HarnessSession, ImageContent, Message, PermissionMode, QuestionResult, TextContent, ThinkingLevel as EngineThinkingLevel } from 'operon-agents'
import type {
  DetailedContextUsage,
  DetailedContextUsageCategory,
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  RuntimeGoal,
  RuntimeSession,
  RuntimeStreamParams,
  RuntimeStreamPart,
} from '@operon/agent-runtime'
import { OperonStreamMapper, planReviewToolCallPart } from './message-mapper.js'
import { operonAgentControl } from './control.js'
import { resolveModel } from './resolve-model.js'

/** Minimal single-consumer async queue used to merge run events + approval prompts. */
class PartQueue {
  private readonly buffer: RuntimeStreamPart[] = []
  private waiter: ((r: IteratorResult<RuntimeStreamPart>) => void) | undefined
  private closed = false

  push(part: RuntimeStreamPart): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: part, done: false })
    } else {
      this.buffer.push(part)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeStreamPart> {
    return {
      next: (): Promise<IteratorResult<RuntimeStreamPart>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift() as RuntimeStreamPart, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      },
    }
  }
}

/**
 * Build the framework `AgentInput` from the request's latest user message. The
 * engine is stateful and carries history, so we feed only the latest message.
 * Text-only → a plain string (unchanged). With image attachments → a `Message[]`
 * carrying both text and `ImageContent`, so vision models see the images.
 */
export function buildAgentInput(messages: ModelMessage[]): AgentInput {
  let latest: ModelMessage | undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      latest = messages[i]
      break
    }
  }
  if (!latest) return ''
  if (typeof latest.content === 'string') return expandSkillMarkers(latest.content)

  const text = expandSkillMarkers(
    latest.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n'),
  )

  const images: ImageContent[] = []
  for (const part of latest.content) {
    const image = toImageContent(part)
    if (image) images.push(image)
  }
  if (images.length === 0) return text

  const content: (TextContent | ImageContent)[] = []
  if (text) content.push({ type: 'text', text })
  content.push(...images)
  const userMessage: Message = { role: 'user', content, timestamp: Date.now() }
  return [userMessage]
}

/**
 * The composer injects `[skill:name]` markers when a skill is picked from the `/`
 * menu (the same chip flow other providers use). A skill is just a tool the agent
 * can invoke, so we turn the marker into a plain instruction naming the skill(s)
 * and strip the raw token — the agent then calls the skill on the normal streamed
 * turn. No special activation path needed.
 */
function expandSkillMarkers(text: string): string {
  const names: string[] = []
  const stripped = text.replace(/\[skill:([\w-]+)\]/g, (_full, name: string) => {
    names.push(name)
    return ''
  })
  const unique = [...new Set(names)]
  if (unique.length === 0) return text
  const body = stripped.replace(/\s+/g, ' ').trim()
  const list = unique.map((n) => `"${n}"`).join(', ')
  const hint = `Use the ${unique.length > 1 ? 'skills' : 'skill'} ${list} to handle this request.`
  return body ? `${hint}\n\n${body}` : hint
}

/** The latest user message's text — used as the goal objective for `asGoal` turns. */
function latestUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content.trim()
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n').trim()
  }
  return ''
}

export interface ParsedSlashCommand {
  readonly name: string
  readonly args: string
}

/** Slash commands handled in-session (control-plane), advertised in the descriptor's slashCommands. */
const SUPPORTED_COMMANDS = new Set(['compact', 'plan'])

export function isSupportedCommand(name: string): boolean {
  return SUPPORTED_COMMANDS.has(name)
}

/** Parse a leading `/name args…` slash command from message text, or null if not one. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1)
  const firstSpace = body.search(/\s/)
  const name = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase()
  if (name.length === 0) return null
  const args = firstSpace === -1 ? '' : body.slice(firstSpace + 1).trim()
  return { name, args }
}

/** Engine `GoalSnapshot` (subset) → the runtime-agnostic `RuntimeGoal` the route/UI consume. */
function toRuntimeGoal(s: {
  objective: string
  status: string
  tokensUsed?: number
  wallClockMs?: number
  budget?: { tokenBudget?: number | null }
}): RuntimeGoal {
  return {
    objective: s.objective,
    status: s.status,
    tokenBudget: s.budget?.tokenBudget ?? null,
    tokensUsed: s.tokensUsed,
    timeUsedSeconds: s.wallClockMs != null ? Math.round(s.wallClockMs / 1000) : undefined,
  }
}

/** Convert an aisdk image/file message part to framework `ImageContent`, or undefined. */
function toImageContent(part: unknown): ImageContent | undefined {
  if (!part || typeof part !== 'object') return undefined
  const p = part as Record<string, unknown>
  if (p.type !== 'image' && p.type !== 'file') return undefined

  let mime = typeof p.mediaType === 'string' ? p.mediaType : typeof p.mimeType === 'string' ? p.mimeType : undefined
  const value = p.image ?? p.data ?? p.url
  let base64: string | undefined

  if (typeof value === 'string') {
    const dataUrl = value.match(/^data:([^;]+);base64,(.+)$/i)
    if (dataUrl) {
      mime = mime ?? dataUrl[1]
      base64 = dataUrl[2]
    } else if (/^https?:\/\//i.test(value)) {
      return undefined // remote URL — the framework can't fetch it
    } else {
      base64 = value.replace(/\s+/g, '') // already-raw base64
    }
  } else if (value instanceof Uint8Array) {
    base64 = Buffer.from(value).toString('base64')
  } else if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    base64 = Buffer.from(new Uint8Array(value)).toString('base64')
  } else if (value && typeof value === 'object') {
    const inner = value as Record<string, unknown>
    const innerData = inner.data ?? inner.base64
    if (typeof innerData === 'string') base64 = innerData.replace(/\s+/g, '')
    mime = mime ?? (typeof inner.mediaType === 'string' ? inner.mediaType : typeof inner.mimeType === 'string' ? inner.mimeType : undefined)
  }

  if (!base64) return undefined
  // A non-image file slipped through (operon turns those into text refs upstream) — skip.
  if (p.type === 'file' && mime && !mime.startsWith('image/')) return undefined
  return { type: 'image', data: base64, mimeType: mime ?? 'image/png' }
}

function toApprovalResponse(decision: PermissionDecision): ApprovalResponse {
  switch (decision.type) {
    case 'allow':
      return { decision: 'approved' }
    case 'allow-always':
      return { decision: 'approved', scope: 'session' }
    case 'deny':
      return { decision: 'rejected', feedback: decision.reason }
  }
}

function toQuestionResult(decision: PermissionDecision): QuestionResult {
  if (decision.type === 'deny') return null
  const answers = (decision.updatedInput?.answers ?? {}) as Record<string, string | string[]>
  return { answers }
}

// operon mode id → engine permission mode. operon's mode ids are aligned 1:1 with the engine
// modes: manual / workspace / yolo / auto. `auto` is the LLM-judged tier (Claude-Code-style):
// the static chain runs first and any residual would-prompt action is handed to the
// `LlmAutoApprover` injected in buildHarness. Unknown ids fall back to `manual`.
// Lives here rather than in index.ts so both session creation and mid-stream
// `dynamicSet` read one table (index.ts already imports this module).
export const MODE_TO_PERMISSION: Record<string, PermissionMode> = {
  manual: 'manual',
  workspace: 'workspace',
  yolo: 'yolo',
  auto: 'auto',
}

/** Injector ids the engine reports; anything unlisted is title-cased as a fallback. */
const INJECTION_LABELS: Record<string, string> = {
  skill_catalog: 'Skills catalog',
  todo: 'Todos',
  task: 'Tasks',
  plan_mode: 'Plan mode',
  goal: 'Goal',
}

const injectionLabel = (id: string): string =>
  INJECTION_LABELS[id] ?? id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/**
 * `RuntimeSession` backed by an in-process `operon-agents` HarnessSession.
 *
 * The HarnessSession is stateful (it persists its own conversation tree), so each
 * `stream()` feeds only the latest user message and lets the engine carry history.
 */
export class OperonRuntimeSession implements RuntimeSession {
  private readonly harness: HarnessSession
  private currentModelId: string
  private currentModeId: string
  /** Approval promises awaiting `resolvePermission(approvalId, …)`. */
  private readonly pendingApprovals = new Map<string, (response: ApprovalResponse) => void>()
  /**
   * AskUserQuestion promises awaiting an answer. Answers ride the SAME permission
   * round-trip as approvals — the UI submits `onPermissionDecide(approvalId, 'allow',
   * { answers })`, so they arrive at `resolvePermission` with `updatedInput.answers`.
   */
  private readonly pendingQuestions = new Map<string, (result: QuestionResult) => void>()

  constructor(harness: HarnessSession, modelId: string, modeId: string) {
    this.harness = harness
    this.currentModelId = modelId
    this.currentModeId = modeId
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    // Slash commands (/compact, /plan …) are control-plane actions, not model turns:
    // run them against the session and stream a short confirmation instead of prompting.
    const command = parseSlashCommand(latestUserText(params.messages))
    if (command && isSupportedCommand(command.name)) {
      yield* this.streamCommand(command)
      return
    }

    const queue = new PartQueue()
    const mapper = new OperonStreamMapper()

    const unsubscribe = this.harness.onEvent((event) => {
      for (const part of mapper.map(event)) queue.push(part)
    })

    // Tool approvals: surface a request part, then block until resolvePermission().
    this.harness.setApprovalHandler(
      (request, options) =>
        new Promise<ApprovalResponse>((resolve) => {
          const signal = options?.signal ?? params.signal
          if (signal?.aborted) {
            resolve({ decision: 'cancelled' })
            return
          }
          const approvalId = randomUUID()
          let onAbort: (() => void) | undefined
          const settle = (response: ApprovalResponse): void => {
            if (onAbort) signal?.removeEventListener('abort', onAbort)
            resolve(response)
          }
          onAbort = () => {
            const pending = this.pendingApprovals.get(approvalId)
            if (!pending) return
            this.pendingApprovals.delete(approvalId)
            pending({ decision: 'cancelled' })
          }
          this.pendingApprovals.set(approvalId, settle)
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) {
            onAbort()
            return
          }
          // Plan review: re-emit the ExitPlanMode tool-call carrying the plan markdown
          // (it lives in the approval's display, not the tool args) so PlanRenderer shows it.
          const planPart = planReviewToolCallPart(request)
          if (planPart) queue.push(planPart)
          queue.push({
            type: 'tool-approval-request',
            approvalId,
            toolCall: { type: 'tool-call', toolCallId: request.toolCallId, toolName: request.toolName, input: {}, dynamic: true },
          } as unknown as RuntimeStreamPart)
        }),
    )

    // AskUserQuestion: same channel as approvals. The AskUserQuestion tool-call part
    // (already in the message stream) renders the form, keyed by toolCallId; this
    // approval-request carries the approvalId the UI submits the answer against.
    this.harness.setQuestionHandler(
      (request, options) =>
        new Promise<QuestionResult>((resolve) => {
          const signal = options?.signal ?? params.signal
          if (signal?.aborted) {
            resolve(null)
            return
          }
          const approvalId = randomUUID()
          let onAbort: (() => void) | undefined
          const settle = (result: QuestionResult): void => {
            if (onAbort) signal?.removeEventListener('abort', onAbort)
            resolve(result)
          }
          onAbort = () => {
            const pending = this.pendingQuestions.get(approvalId)
            if (!pending) return
            this.pendingQuestions.delete(approvalId)
            pending(null)
          }
          this.pendingQuestions.set(approvalId, settle)
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) {
            onAbort()
            return
          }
          queue.push({
            type: 'tool-approval-request',
            approvalId,
            toolCall: { type: 'tool-call', toolCallId: request.toolCallId, toolName: 'AskUserQuestion', input: {}, dynamic: true },
          } as unknown as RuntimeStreamPart)
        }),
    )

    // Goal turn: set an active thread goal first (emits `goal_updated` → the mapper turns
    // it into `codexGoal` metadata, lighting up the banner), then run the pursuit turn.
    if (params.asGoal) {
      const objective = latestUserText(params.messages)
      if (objective) await this.harness.createGoal({ objective })
    }

    const input = buildAgentInput(params.messages)
    const run = this.harness.prompt(input)
    void run
      .catch((error) => queue.push({ type: 'error', error } as RuntimeStreamPart))
      .finally(() => {
        this.rejectPending()
        queue.close()
      })

    try {
      for await (const part of queue) yield part
    } finally {
      unsubscribe()
      this.harness.setApprovalHandler(undefined)
      this.harness.setQuestionHandler(undefined)
    }
  }

  /** Stream a slash command's result as a single assistant text message. */
  private async *streamCommand(command: ParsedSlashCommand): AsyncIterable<RuntimeStreamPart> {
    let text: string
    try {
      text = await this.executeCommand(command)
    } catch (error) {
      text = `Command /${command.name} failed: ${error instanceof Error ? error.message : String(error)}`
    }
    const id = 'cmd-0'
    yield { type: 'start' } as RuntimeStreamPart
    yield { type: 'start-step' } as RuntimeStreamPart
    yield { type: 'text-start', id } as RuntimeStreamPart
    yield { type: 'text-delta', id, text } as RuntimeStreamPart
    yield { type: 'text-end', id } as RuntimeStreamPart
    yield { type: 'finish-step' } as RuntimeStreamPart
    yield { type: 'finish', finishReason: 'stop' } as RuntimeStreamPart
  }

  /** Run a supported slash command against the session control plane. */
  private async executeCommand(command: ParsedSlashCommand): Promise<string> {
    switch (command.name) {
      case 'compact': {
        const sub = command.args.trim().toLowerCase()
        if (sub === 'status' || sub === 'pending') {
          const pending = await this.harness.pendingCompaction()
          return pending ? 'Compaction is pending — it runs before the next turn.' : 'No pending compaction.'
        }
        if (sub === 'cancel') {
          const cancelled = await this.harness.cancelCompaction()
          return cancelled ? 'Cancelled the pending compaction.' : 'No pending compaction to cancel.'
        }
        const instruction = command.args.trim()
        await this.harness.compact(instruction.length > 0 ? { instruction } : {})
        return 'Compaction requested — it runs before the next turn.'
      }
      case 'plan': {
        const sub = command.args.trim().toLowerCase()
        if (sub === 'off' || sub === 'exit' || sub === 'clear') {
          await this.harness.setPlanMode(false)
          return 'Plan mode off — all tools are available again.'
        }
        if (sub === 'show' || sub === 'status') {
          const plan = await this.harness.getPlan()
          return plan ? 'Plan mode is on.' : 'Plan mode is off.'
        }
        await this.harness.setPlanMode(true)
        return 'Plan mode on — I will investigate read-only and present a plan for your approval before making changes.'
      }
      default:
        return `Unknown command: /${command.name}`
    }
  }

  abort(): void {
    this.harness.cancel()
    this.rejectPending()
  }

  async getGoal(): Promise<RuntimeGoal | null> {
    const snapshot = await this.harness.getGoal()
    return snapshot ? toRuntimeGoal(snapshot) : null
  }

  async setGoalStatus(status: 'active' | 'paused'): Promise<RuntimeGoal | null> {
    const snapshot = status === 'paused' ? await this.harness.pauseGoal() : await this.harness.resumeGoal()
    return snapshot ? toRuntimeGoal(snapshot) : null
  }

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    // AskUserQuestion answers arrive on this same channel (updatedInput.answers).
    const resolveQuestion = this.pendingQuestions.get(approvalId)
    if (resolveQuestion) {
      this.pendingQuestions.delete(approvalId)
      resolveQuestion(toQuestionResult(decision))
      return true
    }
    const resolve = this.pendingApprovals.get(approvalId)
    if (!resolve) return false
    this.pendingApprovals.delete(approvalId)
    resolve(toApprovalResponse(decision))
    return true
  }

  async injectMessage(content: string): Promise<void> {
    const trimmed = content.trim()
    if (trimmed) this.harness.steer(trimmed)
  }

  /**
   * Switch model / permission mode / thinking effort on a live session, including
   * mid-stream — the engine applies them at the next turn boundary, so an in-flight
   * run picks the new mode up on its next tool call instead of having to be stopped.
   *
   * All three are settable here, which is what keeps an ordinary conversation off
   * the session-rebuild path entirely: those are the only settings that change once
   * a chat is under way.
   */
  async dynamicSet(payload: DynamicSetPayload): Promise<DynamicSetApplied> {
    const applied: DynamicSetApplied = []
    if (payload.modelId) {
      this.currentModelId = payload.modelId
      this.harness.setModel(await resolveModel(payload.modelId))
      applied.push('modelId')
    }
    if (payload.modeId) {
      this.currentModeId = payload.modeId
      await this.harness.setPermissionMode(MODE_TO_PERMISSION[payload.modeId] ?? 'manual')
      applied.push('modeId')
    }
    if (payload.thinkingLevel) {
      this.harness.setThinking(payload.thinkingLevel as EngineThinkingLevel)
      applied.push('thinkingLevel')
    }
    return applied
  }

  getDescriptorPatch(): { currentModelId: string; currentModeId: string } {
    return { currentModelId: this.currentModelId, currentModeId: this.currentModeId }
  }

  /**
   * Context-window breakdown for the chat's usage panel.
   *
   * The engine snapshots this at every turn boundary from exactly the `{ system,
   * tools, messages }` it is about to send, so the buckets sum to the real request
   * rather than to a separate re-derivation. The numbers are ESTIMATES (the same
   * char/4 heuristic the compaction strategy runs on), not tokenizer output — fine
   * for "where are my tokens going", not for reconciling against billing.
   *
   * Returns null until the first turn has been prepared: the snapshot is taken on
   * the way into a turn, so a freshly opened session has nothing to report yet.
   */
  async getContextUsage(): Promise<DetailedContextUsage | null> {
    const breakdown = this.harness.getContextBreakdown()
    if (!breakdown) return null

    const categories: DetailedContextUsageCategory[] = [
      { name: 'System prompt', tokens: breakdown.systemPrompt.tokens, color: 'system' },
      { name: 'Tools', tokens: breakdown.toolsBuiltin.tokens, color: 'tools' },
      { name: 'MCP tools', tokens: breakdown.toolsMcp.tokens, color: 'mcp' },
      { name: 'Messages', tokens: breakdown.messages.tokens, color: 'messages' },
      // Turn-boundary injections arrive largest-first and are already excluded from
      // `messages`, so listing them as siblings doesn't double-count.
      ...breakdown.injections.map((injection) => ({
        name: injectionLabel(injection.id),
        tokens: injection.tokens,
        color: 'injection',
      })),
      { name: 'Compact buffer', tokens: breakdown.compactBuffer.tokens, color: 'compact' },
      { name: 'Free space', tokens: breakdown.free.tokens, color: 'free' },
    ].filter((category) => category.tokens > 0)

    return {
      categories,
      totalTokens: breakdown.used,
      maxTokens: breakdown.contextWindow,
      rawMaxTokens: breakdown.contextWindow,
      percentage: breakdown.usedPercent,
      model: breakdown.model,
      // The engine reports no per-file memory attribution, and the panel hides the
      // section on an empty list.
      memoryFiles: [],
      isAutoCompactEnabled: breakdown.compactBuffer.tokens > 0,
      apiUsage: null,
    }
  }

  /**
   * The framework session id (= core session id). The route layer persists this on
   * the chat record and feeds it back as `params.sessionId` to resume after the
   * in-memory session is evicted or the app restarts.
   */
  getSessionId(): string | undefined {
    return this.harness.id
  }

  async dispose(): Promise<void> {
    this.abort()
    await this.harness.close()
  }

  private rejectPending(): void {
    for (const resolve of this.pendingApprovals.values()) resolve({ decision: 'cancelled' })
    this.pendingApprovals.clear()
    for (const resolve of this.pendingQuestions.values()) resolve(null)
    this.pendingQuestions.clear()
  }

  /** Agent runtime control (MCP / cron / tasks / skills / …) — delegates each
   *  method to this session's harness. See `control.ts`. */
  agentControl(method: string, params: unknown): Promise<unknown> {
    return operonAgentControl(this.harness, method, params)
  }
}
