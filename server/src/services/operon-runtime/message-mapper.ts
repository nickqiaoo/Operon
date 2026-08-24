import type { AgentEvent, Usage } from 'operon-agents-core'
import type { RuntimeStreamPart } from '@operon/agent-runtime'

/**
 * Translate the framework's `AgentEvent` stream into the aisdk `TextStreamPart`
 * vocabulary operon's UI consumes (`text-stream-part-to-ui.ts`).
 *
 * One `provider.stream()` call = one run = one UI assistant message. The run is a
 * sequence of steps framed by `turn.step.started` / `turn.step.completed`; each
 * step streams text (`assistant.delta`), thinking (`thinking.delta`) and tool
 * calls (`tool.call.delta` / `tool.call.started`), with `content.part` closing a
 * completed text/thinking block. Tool results arrive per-tool via `tool.result`.
 *
 * The event vocabulary is the kimi-shaped dotted `namespace.event` model (post
 * "rework AgentEvent message lifecycle"): the old `message_*` / `tool_execution_*`
 * / inner `assistantMessageEvent` layering is gone — deltas are now flat top-level
 * events carrying their own `toolCallId`. This mirrors the framework's own
 * `AgentEventToUiStream` (in `operon-agents-core/ui`) for block/step framing, but
 * emits operon `RuntimeStreamPart`s and keeps our richer surfacing (sub-agent
 * nesting, workflow progress, todo/goal/plan bridging, context-usage gauge).
 *
 * Our framework's tools are unknown to the client, so every tool part is emitted as
 * `dynamic: true` — the UI renders them generically, keyed by `toolName`.
 *
 * Sub-agents
 * ----------
 * Sub-agent events carry a nested address (`main/<agentId>`, or deeper). Their TOOL
 * steps are surfaced as child parts tagged with `providerMetadata.operon.parentToolCallId`
 * pointing at the spawning `Agent` tool call, so the UI's SubAgentRenderer nests them
 * under that task — the SAME inline contract the claude-code / opencode providers use.
 * Only tool steps are surfaced (the renderer shows steps, not the sub-agent's prose).
 *
 * Correlation: a sub-agent's first event is `agent.started`, which carries
 * `parentToolCallId` — the id of the tool call that spawned it (framework contract). We
 * bind the sub-agent address to that id deterministically (no ordering guess; correct
 * under parallel spawns). We only bind to an `Agent`/`agent_<name>` spawn, whose UI card
 * (SubAgentRenderer) renders nested children. A `Workflow` sub-agent's parent is the
 * Workflow tool call, whose card renders its OWN progress (not nested children), so we
 * leave it unbound — its steps show via workflow progress, and an approval is force-
 * surfaced top-level by the session handler. Background agents whose run outlives this
 * stream are likewise unbound.
 *
 * Tool results
 * --------------
 * Each tool's result is surfaced from the per-tool `tool.result` event (emitted the
 * moment the result lands). Turn-terminal events carry no results of their own — a
 * batch collected at the end of the turn would leave every mid-turn tool spinning
 * until then — so `tool.result` is the only source: once per result (same per-tool
 * timing the CLI providers like kimi use), keyed by toolCallId.
 */
const PROVIDER_KEY = 'operon'
/** Max progress lines kept per tool-call — bounds the re-emitted live output (never persisted). */
const PROGRESS_TAIL = 50
/** Max activity items kept in a workflow progress accumulator (logs are the unbounded source). */
const PROGRESS_MAX_ACTIVITIES = 100

/** Mirror of the frontend `isSubagentProgress` shape — SubAgentRenderer reads this off the output. */
interface ProgressActivity {
  id: string
  type: 'thought' | 'tool_call'
  content: string
  displayName?: string
  output?: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
}
interface SubagentProgressOutput {
  isSubagentProgress: true
  agentName: string
  state: 'running' | 'completed' | 'error' | 'cancelled'
  recentActivity: ProgressActivity[]
}
/** Per-tool workflow progress (activities keyed by id so repeated updates dedup in place). */
interface WorkflowProgressAcc {
  agentName: string
  activities: Map<string, ProgressActivity>
  logSeq: number
}
/** Structural view of the framework `WorkflowProgressEvent` (carried in the tool update's customData). */
type WorkflowEvent =
  | { type: 'phase'; index: number; title: string }
  | { type: 'agent'; record: { index: number; label: string; state: 'running' | 'done' | 'error'; resultPreview?: string; error?: string } }
  | { type: 'log'; message: string }

export class OperonStreamMapper {
  private started = false
  private finished = false
  private stepIndex = -1
  /** Whether a text / thinking block is currently open (synthesise start/end around the flat deltas). */
  private textOpen = false
  private reasoningOpen = false
  /** Monotonic ids per opened block — unique across the run so the UI never merges/reuses a closed part. */
  private textSeq = 0
  private reasoningSeq = 0
  private currentTextId: string | undefined
  private currentReasoningId: string | undefined
  /** Sub-agent root address segment → spawning tool-call id (null = unbound). */
  private readonly addrToParent = new Map<string, string | null>()
  /** Accumulated plain-text progress lines per tool-call id (non-workflow tools). */
  private readonly toolProgress = new Map<string, string[]>()
  /** Workflow progress accumulator per tool-call id (→ isSubagentProgress activity list). */
  private readonly workflowProgress = new Map<string, WorkflowProgressAcc>()
  /** Tool-call ids already surfaced as a `tool-input-start` (dedupe the streaming `tool.call.delta`). */
  private readonly startedInputs = new Set<string>()
  /**
   * Tool-call ids for which we've already emitted a `tool-call` part. The model's
   * streaming `tool.call.delta` and the authoritative `tool.call.started` / `tool.result`
   * are independent; we emit the `tool-call` from whichever arrives first and dedupe on
   * the rest. Without this, a `tool.result` with no preceding `tool-call` makes aisdk throw
   * "No tool invocation found".
   */
  private readonly emittedToolCalls = new Set<string>()

  map(event: AgentEvent): RuntimeStreamPart[] {
    // Nested address ("main/<agentId>") = a sub-agent; surface its tool steps under
    // the spawning Agent task. Top-level ("main") feeds the main assistant message.
    return event.address.includes('/') ? this.mapNested(event) : this.mapTopLevel(event)
  }

  /**
   * Emit a `tool-call` for `toolCallId` unless one was already emitted. `tool.call.started`
   * carries the tool name + full args for every call, so it's the authoritative source that
   * guarantees every `tool-result` is preceded by its `tool-call`.
   */
  private emitToolCallOnce(
    push: (part: RuntimeStreamPart) => void,
    toolCallId: string,
    toolName: string,
    input: unknown,
    meta?: Record<string, unknown>,
  ): void {
    if (this.emittedToolCalls.has(toolCallId)) return
    this.emittedToolCalls.add(toolCallId)
    const remapped = remapTodoTool(toolName, input)
    push({
      type: 'tool-call',
      toolCallId,
      toolName: remapped.name,
      input: remapped.input,
      dynamic: true,
      ...(meta ? { providerMetadata: meta } : {}),
    } as RuntimeStreamPart)
  }

  private mapTopLevel(event: AgentEvent): RuntimeStreamPart[] {
    const out: RuntimeStreamPart[] = []
    const push = (part: RuntimeStreamPart): void => void out.push(part)

    if (!this.started) {
      this.started = true
      push({ type: 'start' } as RuntimeStreamPart)
    }

    switch (event.type) {
      case 'turn.step.started':
        // A new step in the run — the boundary that used to be an assistant `message_start`.
        this.stepIndex += 1
        push({ type: 'start-step' } as RuntimeStreamPart)
        break

      case 'turn.step.completed': {
        // Close any streaming text/thinking block before finishing the step (correct ordering).
        this.closeOpenBlocks(push)
        push({ type: 'finish-step' } as RuntimeStreamPart)
        // NOTE: the framework's `usage.updated` event is CUMULATIVE (summed across every call in
        // the run), which is wrong for a context-window gauge. Per-CALL usage rides on the step
        // instead (`turn.ended` carries none), and the last step of the turn wins on merge — so
        // the badge/popup show CURRENT context occupancy, not lifetime consumption.
        const usage = event.usage
        if (!usage) break
        // This step's call: input ≈ the prompt that was sent (= current context size),
        // output = its response. `contextUsage` drives the % gauge against the model window.
        const metadata: Record<string, unknown> = { usage: usageMetadata(usage) }
        const promptTokens = calculateContextTokens(usage)
        const contextWindow = event.contextWindow ?? 0
        if (promptTokens > 0) {
          const contextUsage: Record<string, number> = { promptTokens }
          if (contextWindow > 0) {
            contextUsage.contextWindow = contextWindow
            contextUsage.percentUsed = promptTokens / contextWindow
          }
          metadata.contextUsage = contextUsage
        }
        push({ type: 'message-metadata', metadata })
        break
      }

      case 'assistant.delta':
        if (!this.textOpen) {
          this.textOpen = true
          this.currentTextId = `t${this.textSeq++}`
          push({ type: 'text-start', id: this.currentTextId } as RuntimeStreamPart)
        }
        push({ type: 'text-delta', id: this.currentTextId!, text: event.delta } as RuntimeStreamPart)
        break

      case 'thinking.delta':
        if (!this.reasoningOpen) {
          this.reasoningOpen = true
          this.currentReasoningId = `r${this.reasoningSeq++}`
          push({ type: 'reasoning-start', id: this.currentReasoningId } as RuntimeStreamPart)
        }
        push({ type: 'reasoning-delta', id: this.currentReasoningId!, text: event.delta } as RuntimeStreamPart)
        break

      case 'content.part':
        // A completed part closes its streaming block (before the following tool call / next part).
        if (event.part.type === 'text' && this.textOpen && this.currentTextId) {
          push({ type: 'text-end', id: this.currentTextId } as RuntimeStreamPart)
          this.textOpen = false
        } else if (event.part.type === 'thinking' && this.reasoningOpen && this.currentReasoningId) {
          push({ type: 'reasoning-end', id: this.currentReasoningId } as RuntimeStreamPart)
          this.reasoningOpen = false
        }
        break

      case 'tool.call.delta':
        // Streaming tool arguments. The event carries its own toolCallId now (no partial lookup);
        // toolName is present on the first delta, so surface a single tool-input-start per call.
        if (event.toolName !== undefined && !this.startedInputs.has(event.toolCallId)) {
          this.startedInputs.add(event.toolCallId)
          push({ type: 'tool-input-start', id: event.toolCallId, toolName: remapToolName(event.toolName), dynamic: true } as RuntimeStreamPart)
        }
        if (event.argumentsPart.length > 0) {
          push({ type: 'tool-input-delta', id: event.toolCallId, delta: event.argumentsPart } as RuntimeStreamPart)
        }
        break

      case 'tool.call.started':
        // The authoritative tool-call signal (full args). Fires once per call, before its result —
        // and before the interrupt approval, so the approval card sees the real input, not `{}`.
        this.emitToolCallOnce(push, event.toolCallId, event.toolName, event.args)
        break

      case 'tool.progress': {
        // Live progress, surfaced as the running tool's output so the card shows activity. Progress is
        // live-only — never persisted (tool.result overwrites it). Bounded so a chatty tool can't grow
        // the re-emitted output unboundedly.
        this.emitToolCallOnce(push, event.toolCallId, event.toolName, event.args)
        const up = event.update
        if (up.customKind === 'workflow' && up.customData) {
          // Workflow phases/agents → a live activity list (the generic SubAgentRenderer path).
          const acc = this.workflowProgress.get(event.toolCallId) ?? { agentName: event.toolName, activities: new Map(), logSeq: 0 }
          applyWorkflowEvent(acc, up.customData as WorkflowEvent)
          this.workflowProgress.set(event.toolCallId, acc)
          push(progressPart(event.toolCallId, event.toolName, acc, 'running'))
        } else if (up.text) {
          // Other tools (e.g. MCP auth status): plain accumulated text, bounded tail.
          const lines = this.toolProgress.get(event.toolCallId) ?? []
          lines.push(up.text)
          if (lines.length > PROGRESS_TAIL) lines.splice(0, lines.length - PROGRESS_TAIL)
          this.toolProgress.set(event.toolCallId, lines)
          push({
            type: 'tool-result',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: undefined,
            output: lines.join('\n'),
            dynamic: true,
          } as RuntimeStreamPart)
        }
        break
      }

      case 'tool.result': {
        // Ensure the tool-call exists before its result (covers a stream we joined mid-flight) —
        // never emit an orphan result.
        this.emitToolCallOnce(push, event.toolCallId, event.toolName, undefined)
        const acc = this.workflowProgress.get(event.toolCallId)
        this.workflowProgress.delete(event.toolCallId)
        this.toolProgress.delete(event.toolCallId)
        if (acc) {
          // Workflow done — settle any activity the framework left mid-flight (otherwise a
          // never-finalized agent spins forever), then append the final result as an item.
          const settled = event.isError ? 'error' : 'completed'
          for (const a of acc.activities.values()) {
            if (a.status === 'running') a.status = settled
          }
          const text = resultText(event.result).slice(0, 4000)
          if (text) acc.activities.set('result', { id: 'result', type: 'thought', content: text, status: settled })
          push(progressPart(event.toolCallId, event.toolName, acc, settled))
        } else {
          // Per-tool result — flips the tool card from running → done as soon as it lands.
          push(this.toolResultPart(event))
        }
        break
      }

      case 'goal.updated':
        // Surface the thread goal as `codexGoal` message-metadata — the same shape the
        // frontend GoalBanner / useGoal already consume for the codex provider.
        push({ type: 'message-metadata', metadata: { codexGoal: goalMetadata(event.snapshot) } })
        break

      case 'error':
        push({ type: 'error', error: event.message } as RuntimeStreamPart)
        break

      case 'agent.ended':
        // The outermost agent finishing ends the run (nested addresses handled in mapNested).
        if (!this.finished) {
          this.finished = true
          push({ type: 'finish', finishReason: 'stop' } as RuntimeStreamPart)
        }
        break

      default:
        break
    }

    return out
  }

  /** Close any open text / thinking block at a step boundary. */
  private closeOpenBlocks(push: (part: RuntimeStreamPart) => void): void {
    if (this.textOpen && this.currentTextId) {
      push({ type: 'text-end', id: this.currentTextId } as RuntimeStreamPart)
      this.textOpen = false
    }
    if (this.reasoningOpen && this.currentReasoningId) {
      push({ type: 'reasoning-end', id: this.currentReasoningId } as RuntimeStreamPart)
      this.reasoningOpen = false
    }
  }

  /** Surface a sub-agent's tool steps as child parts under its spawning tool call. */
  private mapNested(event: AgentEvent): RuntimeStreamPart[] {
    const seg = rootSegment(event.address)
    if (seg === undefined) return []
    // Bind on the sub-agent's first event (`agent.started`), which carries the id of the tool
    // call that spawned it (`Agent`/`agent_<name>`/`Workflow`). Deterministic — no ordering
    // guess, correct under parallel spawns. null only if the framework left it unset.
    if (event.type === 'agent.started' && !this.addrToParent.has(seg)) {
      this.addrToParent.set(seg, event.parentToolCallId ?? null)
    }
    const parentToolCallId = this.addrToParent.get(seg)
    if (!parentToolCallId) return [] // unbound — don't mis-attribute

    const meta = { [PROVIDER_KEY]: { parentToolCallId } }
    const out: RuntimeStreamPart[] = []
    const push = (part: RuntimeStreamPart): void => void out.push(part)

    switch (event.type) {
      case 'tool.call.delta':
        // Stream the sub-agent's tool arguments as a child part under the parent task.
        if (event.toolName !== undefined && !this.startedInputs.has(event.toolCallId)) {
          this.startedInputs.add(event.toolCallId)
          push({ type: 'tool-input-start', id: event.toolCallId, toolName: event.toolName, dynamic: true, providerMetadata: meta } as RuntimeStreamPart)
        }
        if (event.argumentsPart.length > 0) {
          push({ type: 'tool-input-delta', id: event.toolCallId, delta: event.argumentsPart } as RuntimeStreamPart)
        }
        break

      case 'tool.call.started':
        // Authoritative tool-call signal for the sub-agent (full args), before its approval/result.
        this.emitToolCallOnce(push, event.toolCallId, event.toolName, event.args, meta)
        break

      case 'tool.result':
        // The sub-agent's tool result merges by toolCallId into the child tool part; carry the
        // parent tag so it nests correctly. Ensure the call exists first (never an orphan result).
        this.emitToolCallOnce(push, event.toolCallId, event.toolName, undefined, meta)
        push(this.toolResultPart(event, meta))
        break

      default:
        break
    }

    return out
  }

  private toolResultPart(
    event: Extract<AgentEvent, { type: 'tool.result' }>,
    meta?: Record<string, unknown>,
  ): RuntimeStreamPart {
    const text = (event.result.content as ReadonlyArray<{ type: string; text?: string }>)
      .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('')
    const tag = meta ? { providerMetadata: meta } : {}
    if (event.isError) {
      return { type: 'tool-error', toolCallId: event.toolCallId, error: text, dynamic: true, ...tag } as RuntimeStreamPart
    }
    return {
      type: 'tool-result',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: undefined,
      // The UI's generic ToolOutput stringifies objects; pass the joined text so
      // results render as plain text, not a content-part array dump.
      output: text,
      dynamic: true,
      ...tag,
    } as RuntimeStreamPart
  }
}

/** Fold one workflow progress event into the accumulator (activities dedup by id). */
function applyWorkflowEvent(acc: WorkflowProgressAcc, ev: WorkflowEvent): void {
  if (ev.type === 'phase') {
    acc.activities.set(`phase-${ev.index}`, { id: `phase-${ev.index}`, type: 'thought', content: `▸ ${ev.title}`, status: 'completed' })
  } else if (ev.type === 'agent') {
    const r = ev.record
    const status = r.state === 'done' ? 'completed' : r.state === 'error' ? 'error' : 'running'
    acc.activities.set(`agent-${r.index}`, {
      id: `agent-${r.index}`,
      type: 'tool_call',
      content: r.label,
      displayName: r.label,
      ...(r.resultPreview ?? r.error ? { output: r.resultPreview ?? r.error } : {}),
      status,
    })
  } else if (ev.type === 'log') {
    const id = `log-${acc.logSeq++}`
    acc.activities.set(id, { id, type: 'thought', content: ev.message, status: 'completed' })
  }
  // Bound growth: phases/agents dedup by id; logs accumulate, so drop oldest beyond the cap.
  while (acc.activities.size > PROGRESS_MAX_ACTIVITIES) {
    const oldest = acc.activities.keys().next().value
    if (oldest === undefined) break
    acc.activities.delete(oldest)
  }
}

/** Emit the workflow accumulator as an `isSubagentProgress` tool-result (rendered by SubAgentRenderer). */
function progressPart(toolCallId: string, toolName: string, acc: WorkflowProgressAcc, state: SubagentProgressOutput['state']): RuntimeStreamPart {
  const output: SubagentProgressOutput = { isSubagentProgress: true, agentName: acc.agentName, state, recentActivity: [...acc.activities.values()] }
  return { type: 'tool-result', toolCallId, toolName, input: undefined, output, dynamic: true } as RuntimeStreamPart
}

/** Join a tool result's text content. */
function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
}


// --- todo bridging ----------------------------------------------------------
// The engine's todo tool is `TodoList` with items `{ title, status: 'done' }`. The
// UI's TodoWriteRenderer matches `TodoWrite` and reads items `{ content, status:
// 'completed' }`. Remap here so the engine's list renders in the existing UI with
// no frontend change — the same posture as goal.updated → codexGoal.
const ENGINE_TODO_TOOL = 'TodoList'
const UI_TODO_TOOL = 'TodoWrite'

function remapToolName(name: string): string {
  return name === ENGINE_TODO_TOOL ? UI_TODO_TOOL : name
}

function remapTodoTool(name: string, input: unknown): { name: string; input: unknown } {
  if (name !== ENGINE_TODO_TOOL) return { name, input }
  const todos = (input as { todos?: unknown } | null | undefined)?.todos
  if (!Array.isArray(todos)) return { name: UI_TODO_TOOL, input }
  return { name: UI_TODO_TOOL, input: { todos: todos.map(remapTodoItem) } }
}

function remapTodoItem(item: unknown): { content: string; status: 'pending' | 'in_progress' | 'completed' } {
  const t = (item ?? {}) as { title?: unknown; content?: unknown; status?: unknown }
  const content = typeof t.title === 'string' ? t.title : typeof t.content === 'string' ? t.content : ''
  return { content, status: mapTodoStatus(t.status) }
}

function mapTodoStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  if (status === 'done' || status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  return 'pending'
}

// --- plan bridging ----------------------------------------------------------
// `ExitPlanMode` carries its plan markdown in the tool's *display* (PlanReviewDisplay),
// not its arguments — so the tool-call part the agent emits has no `plan` for the UI's
// PlanRenderer to read. When the approval fires (ApprovalRequest.display), re-emit the
// tool-call with `{ plan, options }` so the same toolCallId's input picks up the plan.
interface PlanReviewDisplay {
  kind?: string
  plan?: string
  path?: string
  options?: ReadonlyArray<{ label: string; description: string }>
}

export function planReviewToolCallPart(
  request: { toolName: string; toolCallId: string; display?: unknown },
): RuntimeStreamPart | null {
  if (request.toolName !== 'ExitPlanMode') return null
  const display = (request.display ?? {}) as PlanReviewDisplay
  if (display.kind !== 'plan_review') return null
  const input: Record<string, unknown> = { plan: display.plan ?? '' }
  if (display.path) input.path = display.path
  if (display.options && display.options.length >= 2) input.options = display.options
  return {
    type: 'tool-call',
    toolCallId: request.toolCallId,
    toolName: 'ExitPlanMode',
    input,
    dynamic: true,
  } as RuntimeStreamPart
}

/** First address segment under the root (`main/<seg>/...` → `<seg>`), or undefined. */
function rootSegment(address: string): string | undefined {
  const parts = address.split('/')
  return parts.length >= 2 && parts[1] ? parts[1] : undefined
}

function usageMetadata(usage: Usage): Record<string, unknown> {
  // `inputTokens` must be the FULL prompt — the UI treats it as the total input
  // (non-cached + cache-read + cache-write). pi reports `input` as the NON-cached portion
  // only, so on a cache-heavy turn `input` collapses (e.g. 511) even though the real
  // context is ~12.8K. Add the cache back to recover the true prompt size, and expose the
  // cache breakdown via `inputTokenDetails` so the popup's Cache Read / Cache Write rows show.
  const inputTokenDetails: Record<string, number> = {}
  if (usage.cacheRead > 0) inputTokenDetails.cacheReadTokens = usage.cacheRead
  if (usage.cacheWrite > 0) inputTokenDetails.cacheWriteTokens = usage.cacheWrite
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(Object.keys(inputTokenDetails).length > 0 ? { inputTokenDetails } : {}),
  }
}

/**
 * Tokens occupied by ONE call's context (= its prompt + response), the basis for the
 * current context-window gauge. Mirrors pi-mono / kimi-code: prefer the provider's
 * `totalTokens`, else sum input + output + cache. NOT summed across the run.
 */
function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/** Engine `GoalSnapshot` (subset we read) → the `codexGoal` shape the UI banner expects. */
interface GoalSnapshotShape {
  objective?: string
  status?: string
  tokensUsed?: number
  wallClockMs?: number
  budget?: { tokenBudget?: number | null }
}

function goalMetadata(snapshot: unknown): Record<string, unknown> {
  const s = (snapshot ?? {}) as GoalSnapshotShape
  return {
    objective: s.objective ?? '',
    status: s.status ?? 'active',
    tokenBudget: s.budget?.tokenBudget ?? null,
    tokensUsed: s.tokensUsed ?? 0,
    timeUsedSeconds: s.wallClockMs != null ? Math.round(s.wallClockMs / 1000) : undefined,
  }
}
