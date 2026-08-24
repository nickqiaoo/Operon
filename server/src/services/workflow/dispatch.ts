/**
 * Workflow sub-agent dispatch (desktop-side).
 *
 * The Workflow MCP tool's `agent()` hook runs each sub-agent through HERE — a
 * real, disposable standalone session on ANY of our providers (custom /
 * codex / claude-code / gemini / kimi / opencode / cursor / copilot). This is
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
import { runAgentTurnText } from '../ai/agent-turn.js'
import { subagentMode } from '../agents/subagent-mode.js'
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
  /**
   * Receives this sub-agent's UI chunks so the run panel can show what it is
   * doing. Without it the panel only knows queued/running/done — the sub-agent's
   * actual work (its text, its tool calls) is produced and then thrown away.
   */
  onChunk?: (chunk: UIMessageChunk) => void
  signal: AbortSignal
}

/**
 * Run one sub-agent to completion on the given provider and return its final
 * text. Creates a disposable standalone session, runs a single turn, disposes.
 */
export async function runProviderAgent(params: ProviderAgentParams): Promise<string> {
  const manager = getSessionManager()
  const session = await manager.createStandaloneSession(params.providerId, {
    cwd: params.cwd,
    modelId: params.modelId,
    // Fixed per provider, NOT derived from the parent turn: a sub-agent runs
    // unattended, and any mode that stops to ask would stall it. Throws for an
    // unregistered provider rather than guessing an id (see subagent-mode.ts).
    modeId: subagentMode(params.providerId),
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
  })
  const userMessage: UIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: params.prompt }],
  }
  try {
    // The one true "give me the final text" path — no hand-rolled delta consumption
    // (that read the wrong field and returned "" from live custom sub-agents).
    return await runAgentTurnText(
      session,
      {
        requestId: randomUUID(),
        messages: await convertToModelMessages([userMessage]),
        signal: params.signal,
        assistantMessageId: randomUUID(),
        originalMessages: [userMessage],
        onPart: approvals.onPart,
      },
      params.onChunk,
    )
  } finally {
    // Deny before dispose: a request still outstanding here will never be answered
    // (the session is going away), and leaving it pending would strand an inbox row.
    approvals.dispose()
    await session.dispose().catch(() => {})
  }
}
