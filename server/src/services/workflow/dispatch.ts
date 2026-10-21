/**
 * Workflow sub-agent dispatch (desktop-side).
 *
 * The Workflow MCP tool's `agent()` hook runs each sub-agent through HERE — a
 * real, disposable standalone session on ANY of our providers (custom /
 * codex / claude-code / kimi / opencode / cursor / copilot). This is
 * the piece that makes the framework `runWorkflow` engine (imported as a
 * library, never modified) dispatch to our agents instead of its own internal
 * profiles.
 *
 * Same turn core as chat (`runAgentTurn`) and the same standalone-session
 * factory the headless memory agent uses, so a workflow sub-agent is an
 * ordinary provider turn — just launched by the orchestrator instead of a user.
 */

import { randomUUID } from 'node:crypto'
import { convertToModelMessages, type UIMessage, type UIMessageChunk } from 'ai'
import { getSessionManager } from '../ai.js'
import { latestUserInput } from '../ai/message-utils.js'
import { runAgentTurnText } from '../ai/agent-turn.js'
import { subagentMode } from '../agents/subagent-mode.js'
import { trackLiveAgent } from './live-agents.js'
import {
  watchDetachedApprovals,
  type DetachedApprovalRequest,
} from '../agents/detached-approvals.js'

export interface ProviderAgentParams {
  /** Provider id to run on (e.g. 'custom', 'codex', 'claude-code'). */
  providerId: string
  /** Model override; undefined lets the provider use its default. */
  modelId?: string
  /** Workspace directory the sub-agent runs in. */
  cwd: string
  /** Self-contained prompt (the sub-agent cannot see the parent conversation). */
  prompt: string
  /** Sub-agent label, used in approval/log lines (e.g. 'codex-a3'). */
  agentId: string
  /** Conversation that launched the workflow — carries the inbox fallback row. */
  parentChatId?: number | null
  /**
   * Publishes a blocked sub-agent onto the run itself, so it shows up on the run
   * card the user is already watching. Without this the only surface is the
   * inbox, which is a fallback, not where the work is being followed.
   */
  onApproval?: (request: DetachedApprovalRequest) => void
  onApprovalSettled?: (approvalId: string) => void
  /** Requests answered "allow" on the spot instead of surfaced (see watchDetachedApprovals). */
  autoAllow?: (toolName: string) => boolean
  /**
   * Receives this sub-agent's UI chunks so the run panel can show what it is
   * doing. Without it the panel only knows queued/running/done — the sub-agent's
   * actual work (its text, its tool calls) is produced and then thrown away.
   */
  onChunk?: (chunk: UIMessageChunk) => void
  /**
   * The run row this agent is, so a person watching can message it while it works
   * (`steerLiveAgent`). Omit for agents nobody can see.
   */
  live?: { runId: string; index: number }
  /** The agent was handed to another provider; `to` runs the prompt from here on. */
  onReplaced?: (from: AgentSeat, to: AgentSeat) => void
  /** The model to use on a provider the agent is handed to without one named. */
  modelFor?: (providerId: string) => string | undefined
  signal: AbortSignal
}

/** Which provider (and model) runs an agent. */
export interface AgentSeat {
  providerId: string
  modelId?: string
}

/**
 * Run one sub-agent to completion and return its final text. Creates a
 * disposable standalone session, runs a single turn, disposes.
 *
 * Someone watching can hand a running agent to another provider
 * (`replaceLiveAgent`): its session is stopped and the same prompt runs again
 * on the new one, until one of them answers. The caller only ever sees the answer.
 */
export async function runProviderAgent(params: ProviderAgentParams): Promise<string> {
  let seat: AgentSeat = { providerId: params.providerId, modelId: params.modelId }
  for (;;) {
    const outcome = await runOnce(params, seat)
    if (outcome.kind === 'done') return outcome.text
    const to: AgentSeat = {
      providerId: outcome.to.providerId,
      modelId: outcome.to.modelId ?? params.modelFor?.(outcome.to.providerId),
    }
    params.onChunk?.({ type: 'data-replaced', data: { from: seat.providerId, to: to.providerId } })
    params.onReplaced?.(seat, to)
    seat = to
  }
}

type RunOutcome = { kind: 'done'; text: string } | { kind: 'replaced'; to: AgentSeat }

async function runOnce(params: ProviderAgentParams, seat: AgentSeat): Promise<RunOutcome> {
  const manager = getSessionManager()
  const session = await manager.createStandaloneSession(seat.providerId, {
    cwd: params.cwd,
    model: seat.modelId,
    // Fixed per provider, NOT derived from the parent turn: a sub-agent runs
    // unattended, and any mode that stops to ask would stall it. Throws for an
    // unregistered provider rather than guessing an id (see subagent-mode.ts).
    mode: subagentMode(seat.providerId),
  })
  // The mode above suppresses ordinary permission prompts, but it cannot suppress
  // everything — `AskUserQuestion` is the agent's own deliberate question, and a
  // few providers still confirm regardless. Anything that does get asked is routed
  // to the launching conversation's inbox, and denied if nobody answers, so an
  // unattended sub-agent can never wedge on a prompt no one can see.
  const approvals = watchDetachedApprovals({
    session,
    parentChatId: params.parentChatId,
    agentId: params.agentId,
    onRequest: params.onApproval,
    onSettled: params.onApprovalSettled,
    autoAllow: params.autoAllow,
  })
  // This agent's own stop, under the run's: stopping the run still stops it, and
  // it can be stopped alone to hand its work to another provider.
  const local = new AbortController()
  const stopWithRun = () => local.abort(params.signal.reason)
  if (params.signal.aborted) local.abort(params.signal.reason)
  else params.signal.addEventListener('abort', stopWithRun, { once: true })
  const handoff: { to?: AgentSeat } = {}
  const untrack = params.live
    ? trackLiveAgent(params.live.runId, params.live.index, {
        session,
        providerId: seat.providerId,
        // Shown in the agent's transcript where it was sent, as the person's words.
        note: (text, id) => params.onChunk?.({ type: 'data-steer', id, data: { text } }),
        replace: (to) => {
          handoff.to = to
          local.abort()
        },
      })
    : undefined
  const userMessage: UIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: params.prompt }],
  }
  try {
    let text: string | undefined
    let failure: unknown
    try {
      // The one true "give me the final text" path — no hand-rolled delta consumption
      // (that read the wrong field and returned "" from live custom sub-agents).
      text = await runAgentTurnText(
        session,
        {
          requestId: randomUUID(),
          input: latestUserInput(await convertToModelMessages([userMessage])),
          signal: local.signal,
          assistantMessageId: randomUUID(),
          originalMessages: [userMessage],
          onPart: approvals.onPart,
        },
        params.onChunk,
      )
    } catch (err) {
      failure = err
    }
    // Handed off: whatever the stopped turn returned or threw is beside the point.
    if (handoff.to) return { kind: 'replaced', to: handoff.to }
    if (failure !== undefined) throw failure
    return { kind: 'done', text: text ?? '' }
  } finally {
    params.signal.removeEventListener('abort', stopWithRun)
    untrack?.()
    // Deny before dispose: a request still outstanding here will never be answered
    // (the session is going away), and leaving it pending would strand an inbox row.
    approvals.dispose()
    await session.close().catch(() => {})
  }
}
