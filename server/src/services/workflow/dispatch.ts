/**
 * Workflow sub-agent dispatch (desktop-side).
 *
 * The Workflow MCP tool's `agent()` hook — and every OperonSpec role — runs each
 * sub-agent through HERE, on ANY of our providers (custom / codex / claude-code /
 * kimi / opencode / cursor / copilot). This is the piece that makes the
 * framework `runWorkflow` engine (imported as a library, never modified)
 * dispatch to our agents instead of its own internal profiles.
 *
 * A sub-agent is a chat. It gets a row of its own (`tp: 'workflow-agent'`), its
 * prompt and reply are stored as that chat's messages, and its turn runs through
 * the same server-turn lifecycle a task session uses (`startServerChat`): live
 * tee for an open tab, Stop, presence. Nothing about its conversation is kept
 * anywhere else — the run's log only names the chat (`chatIds` on the agent row),
 * and a person can open it, read it, and carry on talking to it afterwards.
 */

import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { readStreamAsAsyncIterable, type RuntimeStreamPart } from '@operon/agent-runtime'
import { abortChat, getSessionManager, startServerChat } from '../ai.js'
import { getChatStorage } from '../ai/state.js'
import { isErrorFinish } from '../ai/agent-turn.js'
import { extractAssistantText } from '../ai/message-utils.js'
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
  /** Directory the sub-agent runs in. */
  cwd: string
  /** Self-contained prompt (the sub-agent cannot see the parent conversation). */
  prompt: string
  /** Sub-agent label, used in approval/log lines (e.g. 'codex-a3'). */
  agentId: string
  /** What its chat is called, e.g. 'candidate A · codex'. Defaults to `agentId`. */
  title?: string
  /** The workspace its chat belongs to. Defaults to the launching conversation's. */
  workspaceId?: number | null
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
   * The chats this agent has run as so far, newest last — called each time one
   * is created, so the run row can name it while the agent is still working.
   */
  onChats?: (chatIds: number[]) => void
  /**
   * The run row this agent is, so a person watching can message it while it works
   * (`steerLiveAgent`) or hand it to another provider. Also recorded on its chat.
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
 * Run one sub-agent to completion and return its final text.
 *
 * Someone watching can hand a running agent to another provider
 * (`replaceLiveAgent`): its turn is stopped and the same prompt runs again on the
 * new one, in a new chat (a chat stays on the provider it started on), until one
 * of them answers. The caller only ever sees the answer.
 */
export async function runProviderAgent(params: ProviderAgentParams): Promise<string> {
  let seat: AgentSeat = { providerId: params.providerId, modelId: params.modelId }
  const chatIds: number[] = []
  for (;;) {
    const outcome = await runOnce(params, seat, (chatId) => {
      chatIds.push(chatId)
      params.onChats?.([...chatIds])
    })
    if (outcome.kind === 'done') return outcome.text
    const to: AgentSeat = {
      providerId: outcome.to.providerId,
      modelId: outcome.to.modelId ?? params.modelFor?.(outcome.to.providerId),
    }
    params.onReplaced?.(seat, to)
    seat = to
  }
}

type RunOutcome = { kind: 'done'; text: string } | { kind: 'replaced'; to: AgentSeat }

/** The chat a sub-agent runs as: created empty, its prompt arrives as its first turn. */
function createAgentChat(params: ProviderAgentParams, seat: AgentSeat, modeId: string): { chatId: number; workspaceId?: number } {
  const storage = getChatStorage()
  if (!storage) throw new Error('Chat storage is not ready')
  const workspaceId =
    params.workspaceId ??
    (params.parentChatId != null && params.parentChatId > 0 ? storage.getChatMeta(params.parentChatId)?.workspaceId : undefined) ??
    undefined
  const metadata = {
    modeId,
    workflowAgent: {
      runId: params.live?.runId ?? '',
      index: params.live?.index ?? -1,
      parentChatId: params.parentChatId ?? null,
      cwd: params.cwd,
    },
  }
  const created = storage.patchChatEntry(null, {
    baseRevision: 0,
    replaceFrom: 0,
    tailMessages: [],
    tp: 'workflow-agent',
    title: params.title ?? params.agentId,
    workspaceId,
    providerId: seat.providerId,
    model: seat.modelId,
    updatedAt: Date.now(),
    metadata,
  })
  if (!created.success) throw new Error(`Could not create a chat for ${params.agentId}`)
  return { chatId: created.chatId, workspaceId }
}

async function runOnce(params: ProviderAgentParams, seat: AgentSeat, onChat: (chatId: number) => void): Promise<RunOutcome> {
  // Fixed per provider, NOT derived from the parent turn: a sub-agent runs
  // unattended, and any mode that stops to ask would stall it. Throws for an
  // unregistered provider rather than guessing an id (see subagent-mode.ts).
  const modeId = subagentMode(seat.providerId)
  params.signal.throwIfAborted()
  const { chatId, workspaceId } = createAgentChat(params, seat, modeId)
  onChat(chatId)

  // The mode above suppresses ordinary permission prompts, but it cannot suppress
  // everything — `AskUserQuestion` is the agent's own deliberate question, and a
  // few providers still confirm regardless. Anything that does get asked shows in
  // this chat, on the run card and in the launching conversation's inbox, and is
  // denied if nobody answers, so an unattended sub-agent never wedges on a prompt.
  const approvals = watchDetachedApprovals({
    session: { respond: (approvalId, decision) => getSessionManager().get(chatId)?.runtime.respond(approvalId, decision) ?? false },
    parentChatId: params.parentChatId,
    childChatId: chatId,
    agentId: params.agentId,
    onRequest: params.onApproval,
    onSettled: params.onApprovalSettled,
    autoAllow: params.autoAllow,
  })

  // A turn can fail without throwing: codex reports a failed turn (a usage limit,
  // say) as a finish with reason "error" and writes the error as the reply's
  // text; opencode reports an upstream 429 as an error part.
  let finishedWithError = false
  let streamError: string | undefined
  const onPart = (part: RuntimeStreamPart): void => {
    approvals.onPart(part)
    if (part.type === 'finish' && isErrorFinish((part as { finishReason?: unknown }).finishReason)) finishedWithError = true
    if (part.type === 'error') streamError = String((part as { error?: unknown }).error ?? 'stream error')
  }

  // This agent's own stop, under the run's: stopping the run still stops it, and
  // it can be stopped alone to hand its work to another provider.
  const handoff: { to?: AgentSeat } = {}
  const stop = () => abortChat(chatId)
  params.signal.addEventListener('abort', stop, { once: true })
  const untrack = params.live
    ? trackLiveAgent(params.live.runId, params.live.index, {
        chatId,
        providerId: seat.providerId,
        replace: (to) => {
          handoff.to = to
          stop()
        },
      })
    : undefined

  const userMessage: UIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: params.prompt }] }
  try {
    let message: UIMessage | undefined
    let failure: unknown
    try {
      const ctx = await startServerChat(
        {
          chatId,
          messages: [userMessage],
          providerId: seat.providerId,
          modelId: seat.modelId,
          modeId,
          workspaceId,
          tp: 'workflow-agent',
          // Rewind checkpoints are for a person's own turns in their checkout.
          skipSnapshot: true,
        },
        { onPart },
      )
      // Stopped while the session was starting: the abort above found no turn yet.
      if (params.signal.aborted || handoff.to) abortChat(chatId)
      try {
        for await (const prepared of readStreamAsAsyncIterable(ctx.preparedParts)) {
          const part = (prepared as { part?: { type?: string; error?: unknown } }).part
          if (part?.type === 'error') streamError = String(part.error ?? 'stream error')
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err)
        ctx.recordError(err)
      } finally {
        await ctx.persistDone
        ctx.finish()
      }
      const completion = ctx.completion()
      message = completion.message
      if (completion.status === 'failed' && !streamError) streamError = completion.error ?? 'The turn failed'
    } catch (err) {
      failure = err
    }
    // Handed off: whatever the stopped turn returned or threw is beside the point.
    if (handoff.to) return { kind: 'replaced', to: handoff.to }
    if (params.signal.aborted) throw params.signal.reason instanceof Error ? params.signal.reason : new Error('aborted')
    if (failure !== undefined) throw failure
    if (streamError) throw new Error(streamError)
    const text = message ? extractAssistantText(message) : ''
    if (finishedWithError) throw new Error(text.trim() || 'The turn ended with an error')
    return { kind: 'done', text }
  } finally {
    params.signal.removeEventListener('abort', stop)
    untrack?.()
    // Deny before closing: a request still outstanding here will never be
    // answered, and leaving it pending would strand an inbox row.
    approvals.dispose()
    // The chat stays; its warm session does not. A person who opens it later
    // resumes the provider session from the id the turn stored.
    await getSessionManager()
      .destroy(chatId)
      .catch(() => {})
  }
}
