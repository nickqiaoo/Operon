import { randomUUID } from 'crypto'
import type { ApprovalHandler, ApprovalResponse, QuestionHandler, QuestionResult } from 'operon-agents'
import type { PermissionDecision, RuntimeStreamPart } from '@operon/agent-runtime'
import { planReviewToolCallPart } from './message-mapper.js'

/**
 * Where a run's "the agent is waiting for you" requests go, and where their answers wait.
 *
 * The harness asks a LIVE handler (`setApprovalHandler` / `setQuestionHandler`) when one is
 * registered; with none it persists the run as interrupted (`turn.paused`) and refuses every
 * later prompt until `respond()` resumes it. So any run the UI is showing needs one: the turn
 * operon drove (`OperonRuntimeSession.runTurn`) and the turn the harness started on its own,
 * e.g. woken by a finished background task (`passive-observer`). Both build theirs here.
 */
export interface InteractiveSink {
  /** The run's UI stream: the request part goes here. */
  push(part: RuntimeStreamPart): void
  /** Arguments of the asking call (the request itself carries none). */
  toolInput(toolCallId: string): unknown
  /** Answers awaiting `answerPending`, by approvalId. */
  approvals: Map<string, (response: ApprovalResponse) => void>
  questions: Map<string, (result: QuestionResult) => void>
  /** Cancels a waiting request when the harness passes no signal of its own. */
  signal?: AbortSignal
}

/**
 * Register a waiter under a fresh approvalId and announce it. Settles with the answer, or
 * with `cancelled` when the run is aborted first.
 */
function waitForAnswer<T>(
  pending: Map<string, (value: T) => void>,
  signal: AbortSignal | undefined,
  cancelled: T,
  announce: (approvalId: string) => void,
): Promise<T> {
  return new Promise<T>((resolve) => {
    if (signal?.aborted) {
      resolve(cancelled)
      return
    }
    const approvalId = randomUUID()
    let onAbort: (() => void) | undefined
    const settle = (value: T): void => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    onAbort = () => {
      const waiter = pending.get(approvalId)
      if (!waiter) return
      pending.delete(approvalId)
      waiter(cancelled)
    }
    pending.set(approvalId, settle)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    announce(approvalId)
  })
}

export function interactiveHandlers(sink: InteractiveSink): { approval: ApprovalHandler; question: QuestionHandler } {
  // Tool approvals: surface a request part, then block until `answerPending`.
  const approval: ApprovalHandler = (request, options) =>
    waitForAnswer<ApprovalResponse>(sink.approvals, options?.signal ?? sink.signal, { decision: 'cancelled' }, (approvalId) => {
      // Plan review: re-emit the ExitPlanMode tool-call carrying the plan markdown
      // (it lives in the approval's display, not the tool args) so PlanRenderer shows it.
      const planPart = planReviewToolCallPart(request)
      if (planPart) sink.push(planPart)
      sink.push({
        type: 'tool-approval-request',
        approvalId,
        toolCall: { type: 'tool-call', toolCallId: request.toolCallId, toolName: request.toolName, input: sink.toolInput(request.toolCallId) ?? {}, dynamic: true },
      } as unknown as RuntimeStreamPart)
    })

  // AskUserQuestion: same channel as approvals. The AskUserQuestion tool-call part
  // (already in the message stream) renders the form, keyed by toolCallId; this
  // approval-request carries the approvalId the UI submits the answer against.
  const question: QuestionHandler = (request, options) =>
    waitForAnswer<QuestionResult>(sink.questions, options?.signal ?? sink.signal, null, (approvalId) => {
      sink.push({
        type: 'tool-approval-request',
        approvalId,
        toolCall: { type: 'tool-call', toolCallId: request.toolCallId, toolName: 'AskUserQuestion', input: sink.toolInput(request.toolCallId) ?? {}, dynamic: true },
      } as unknown as RuntimeStreamPart)
    })

  return { approval, question }
}

/**
 * Settle a waiting request with the person's decision. AskUserQuestion answers arrive on the
 * same channel (`updatedInput.answers`). False when the id is not waiting here.
 */
export function answerPending(
  sink: Pick<InteractiveSink, 'approvals' | 'questions'>,
  approvalId: string,
  decision: PermissionDecision,
): boolean {
  const resolveQuestion = sink.questions.get(approvalId)
  if (resolveQuestion) {
    sink.questions.delete(approvalId)
    resolveQuestion(toQuestionResult(decision))
    return true
  }
  const resolve = sink.approvals.get(approvalId)
  if (!resolve) return false
  sink.approvals.delete(approvalId)
  resolve(toApprovalResponse(decision))
  return true
}

/** Settle everything still waiting as cancelled (the run ended or was aborted). */
export function cancelPending(sink: Pick<InteractiveSink, 'approvals' | 'questions'>): void {
  for (const resolve of sink.approvals.values()) resolve({ decision: 'cancelled' })
  sink.approvals.clear()
  for (const resolve of sink.questions.values()) resolve(null)
  sink.questions.clear()
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
