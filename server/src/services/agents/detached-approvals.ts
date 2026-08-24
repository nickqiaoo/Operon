/**
 * Approval bridge for detached sub-agent sessions.
 *
 * A sub-agent runs on a *standalone* session (`createStandaloneSession`), which
 * is deliberately never registered in `SessionManager`'s chat map. That is what
 * makes it disposable — and also what used to make it hang: every approval path
 * we have resolves by chatId (`resolvePermission(chatId, …)`), so a request from
 * a session with no chatId reached nobody. The provider's approval promise then
 * simply never settled, wedging that sub-agent (and its concurrency slot) until
 * the whole run was aborted.
 *
 * This module gives those requests somewhere to go:
 *
 *   1. The request is registered here, keyed by its approvalId.
 *   2. It is mirrored into the LAUNCHING conversation's approval inbox, so it
 *      surfaces as a "waiting on you" row (with a push) exactly like a normal
 *      chat approval.
 *   3. Answering it anywhere (inbox, chat page, mobile) goes through the usual
 *      `POST /permission-response` → `resolvePermission(chatId, …)` path, whose
 *      external-resolver hook lands in `resolveDetachedApproval` below and
 *      forwards the decision to the real sub-agent session.
 *   4. If nobody answers within `APPROVAL_TIMEOUT_MS`, it is auto-DENIED. The
 *      sub-agent gets a normal denial, reports what it could not do, and the run
 *      finishes. Hanging forever is never an outcome.
 *
 * WHY THE INBOX AND NOT THE PARENT'S MESSAGE STREAM: workflows run in the
 * background, so by the time a sub-agent asks, the launching turn has almost
 * always finished and its stream has detached — there is nothing to inject into
 * (`host-approval-broker` cancels outright in that state). Injecting would also
 * require synthesizing a tool-call card in the parent's history for work the
 * parent never did, permanently polluting that conversation. The inbox is
 * already global, already survives an idle chat, and already renders
 * approve/deny inline.
 */

import type { PermissionDecision, RuntimeSession, RuntimeStreamPart, RuntimeTextStreamPart } from '@operon/agent-runtime'
import { observeApprovalPart, resolvePendingApproval } from '../ai/approval-inbox.js'

type ApprovalRequestPart = Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

/**
 * How long an unattended request waits for a human before it is denied.
 *
 * Long enough to walk back to the machine and answer a real question; short
 * enough that a forgotten run still ends on its own. The denial is not silent —
 * the sub-agent is told, and says so in its result.
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** How many recent tool-call inputs to keep for question pairing. */
const TOOL_INPUT_CACHE = 50

/**
 * `AskUserQuestion` is forwarded like any other request — the sub-agent HAS a
 * launching conversation, and its inbox can carry the question.
 *
 * Answers ride the same round-trip as approvals: the UI submits
 * `{ outcome: 'allow', updatedInput: { answers } }`, which arrives at the
 * session's `resolvePermission` and settles the question (see
 * `operon-runtime/session.ts`). The only thing the inbox lacked was the question
 * ITSELF — the approval part carries an empty `input`, because the options live
 * on the `AskUserQuestion` tool-call part in the message stream. That part comes
 * through this same watcher, so `questionInput` below pairs the two back up.
 */

/**
 * Plan review, on the other hand, IS refused outright.
 *
 * Not because it would be hard to render, but because a sub-agent is never put
 * into a plan mode to begin with (see subagent-mode.ts — every entry is an
 * execution mode). Reaching `ExitPlanMode` means the model asked to review a
 * plan nobody requested; the useful answer is "just do the work", and saying so
 * immediately beats parking it for five minutes first.
 */
const PLAN_REVIEW_TOOL = 'ExitPlanMode'

const PLAN_REVIEW_REASON =
  'Plan review is unavailable: you are a workflow sub-agent, and you were not asked to produce a plan. ' +
  'Carry out the task directly and describe what you did in your final answer.'

interface DetachedApproval {
  approvalId: string
  /** Conversation that launched the workflow — where the request surfaces. */
  parentChatId: number
  toolName: string
  /** Settles the request exactly once, whoever gets there first. */
  settle: (decision: PermissionDecision) => void
  timer: NodeJS.Timeout
}

/** approvalId → pending request. Process-local, like every other approval map. */
const pending = new Map<string, DetachedApproval>()

/** One blocked sub-agent request, as handed to whoever displays it. */
export interface DetachedApprovalRequest {
  approvalId: string
  /** Sub-agent that asked, e.g. 'codex-a3'. */
  agentId: string
  toolName: string
  /** The asking tool's input — an AskUserQuestion's `questions`, with options. */
  toolInput?: unknown
  requestedAt: number
}

/**
 * Watch one detached sub-agent's stream for approval traffic.
 *
 * Returns the `onPart` hook to hand to `runAgentTurn`, plus a `dispose` that
 * denies anything still outstanding — a sub-agent that ended (or was aborted)
 * with an unanswered request must not leave a live row anywhere.
 */
export function watchDetachedApprovals(params: {
  session: RuntimeSession
  /** The conversation that launched this sub-agent; <= 0 disables the inbox row. */
  parentChatId: number | null | undefined
  /** Sub-agent label used in log lines (e.g. 'codex-a3'). */
  agentId: string
  /**
   * Extra display surface, on top of the inbox — for a workflow, the run panel,
   * which is where the user actually launched this work and is watching it.
   * Also the seam the tests observe, so question/option pairing can be asserted
   * without standing up notification storage.
   */
  onRequest?: (request: DetachedApprovalRequest) => void
  /** Settled by anyone (answered, denied, timed out) — clear the display. */
  onSettled?: (approvalId: string) => void
  /** Set false to skip the inbox row (the panel alone is the surface). */
  surfaceToInbox?: boolean
}): { onPart: (part: RuntimeStreamPart) => void; dispose: () => void } {
  const owned = new Set<string>()
  /** toolCallId → that call's input, so a question can be paired with its options. */
  const toolInputs = new Map<string, unknown>()
  const { session, agentId } = params
  const parentChatId = params.parentChatId ?? 0
  const surfaceToInbox = params.surfaceToInbox !== false

  const settleOnce = (approvalId: string, decision: PermissionDecision): void => {
    const entry = pending.get(approvalId)
    if (!entry) return
    pending.delete(approvalId)
    owned.delete(approvalId)
    clearTimeout(entry.timer)
    // Clear every surface that showed it, so an answered request stops asking.
    if (parentChatId > 0 && surfaceToInbox) resolvePendingApproval(parentChatId, approvalId)
    try {
      params.onSettled?.(approvalId)
    } catch (err) {
      console.error(`[Workflow] ${agentId}: onSettled failed for ${approvalId}:`, err)
    }
    // Hand the decision to the provider that is blocked on it. Guarded: a
    // disposed session throwing here must not take down the run.
    try {
      session.resolvePermission(approvalId, decision)
    } catch (err) {
      console.error(`[Workflow] ${agentId}: resolvePermission failed for ${approvalId}:`, err)
    }
  }

  const onPart = (part: RuntimeStreamPart): void => {
    // Remember tool-call inputs: an `AskUserQuestion` approval arrives with an
    // empty `input`, and the questions it needs are on the tool-call part that
    // came through earlier under the same toolCallId.
    if (part.type === 'tool-call') {
      const call = part as { toolCallId?: string; input?: unknown }
      if (call.toolCallId) {
        toolInputs.set(call.toolCallId, call.input)
        // Bound the map: a long sub-agent turn makes many calls, and only the
        // most recent ones can still be awaiting an approval.
        if (toolInputs.size > TOOL_INPUT_CACHE) {
          toolInputs.delete(toolInputs.keys().next().value as string)
        }
      }
      return
    }
    if (part.type !== 'tool-approval-request') return
    const req = part as ApprovalRequestPart
    const toolName = req.toolCall?.toolName || 'tool'

    // A plan review nobody asked for — answer it now instead of parking it.
    if (toolName === PLAN_REVIEW_TOOL || req.approvalId.startsWith('plan-approval-')) {
      console.log(`[Workflow] ${agentId}: ${toolName} is not applicable to a sub-agent — declining`)
      try {
        session.resolvePermission(req.approvalId, { type: 'deny', reason: PLAN_REVIEW_REASON })
      } catch (err) {
        console.error(`[Workflow] ${agentId}: resolvePermission failed for ${req.approvalId}:`, err)
      }
      return
    }

    const timer = setTimeout(() => {
      console.warn(
        `[Workflow] ${agentId}: no answer for ${toolName} after ${APPROVAL_TIMEOUT_MS / 1000}s — denying`,
      )
      settleOnce(req.approvalId, {
        type: 'deny',
        reason:
          `No one answered this request within ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} minutes. ` +
          `You are running unattended as a workflow sub-agent — continue without this action and ` +
          `report in your final answer what you could not complete.`,
      })
    }, APPROVAL_TIMEOUT_MS)
    // Never let a pending approval hold the process open.
    timer.unref?.()

    pending.set(req.approvalId, {
      approvalId: req.approvalId,
      parentChatId,
      toolName,
      settle: (decision) => settleOnce(req.approvalId, decision),
      timer,
    })
    owned.add(req.approvalId)

    // Pair a question with its options: the approval part's own input is empty,
    // so fall back to the tool-call that introduced this toolCallId.
    const reqInput = req.toolCall?.input
    const toolInput =
      reqInput && Object.keys(reqInput as Record<string, unknown>).length > 0
        ? reqInput
        : toolInputs.get(req.toolCall?.toolCallId ?? '')

    // Show it where the user is. The run panel (onRequest) is the primary
    // surface — that is where they launched this work and are watching it. The
    // inbox is the fallback for when the app isn't in front of them, and carries
    // the phone push.
    try {
      params.onRequest?.({
        approvalId: req.approvalId,
        agentId,
        toolName,
        toolInput,
        requestedAt: Date.now(),
      })
    } catch (err) {
      console.error(`[Workflow] ${agentId}: surfacing to the run failed:`, err)
    }
    // Only the approval part is forwarded to the inbox: `observeApprovalPart`
    // clears a chat's whole pending map on finish/abort/error, and this
    // sub-agent's stream ending must not wipe the PARENT conversation's own
    // pending approvals.
    if (parentChatId > 0 && surfaceToInbox) {
      try {
        observeApprovalPart(parentChatId, part, true, agentId, toolInput)
      } catch (err) {
        console.error(`[Workflow] ${agentId}: inbox surfacing failed:`, err)
      }
    }
    console.log(`[Workflow] ${agentId}: waiting on approval for ${toolName} (${req.approvalId})`)
  }

  const dispose = (): void => {
    for (const approvalId of [...owned]) {
      settleOnce(approvalId, {
        type: 'deny',
        reason: 'The sub-agent ended before this request was answered.',
      })
    }
  }

  return { onPart, dispose }
}

/**
 * Resolve an approval that belongs to a detached sub-agent.
 *
 * Wired into `SessionManager`'s external-permission resolver, so the ordinary
 * `POST /permission-response` path reaches sub-agents without knowing they
 * exist. Returns false when the id isn't ours, letting the normal chat-session
 * lookup proceed.
 *
 * `chatId` is checked so one conversation cannot answer another's request — the
 * id alone is an unguessable UUID, but the parent link is what the UI acted on.
 */
export function resolveDetachedApproval(
  chatId: number,
  approvalId: string,
  decision: PermissionDecision,
): boolean {
  const entry = pending.get(approvalId)
  if (!entry || entry.parentChatId !== chatId) return false
  entry.settle(decision)
  return true
}

/** Test-only reset; production cleanup happens through `dispose`. */
export function resetDetachedApprovals(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}
