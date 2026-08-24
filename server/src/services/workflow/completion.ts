/**
 * Deliver a finished workflow's result back to the conversation that launched it.
 *
 * SERVER-SIDE on purpose. This used to be done in the browser: the run panel
 * watched the SSE stream and, on a terminal status, called `sendMessage()` with
 * the result — which made the delivery depend on that conversation being open in
 * a mounted component, and made the result appear in the transcript as something
 * the USER had typed. A workflow runs detached, for minutes, possibly while the
 * app is on another tab entirely; whether its result comes back cannot hinge on
 * what the UI happens to be rendering.
 *
 * So the node delivers it. The turn it starts goes through the ordinary chat path
 * (`handleChat`), which means it is persisted, tee'd into the live-turn hub, and
 * announced over the presence channel — every surface attached to that chat picks
 * it up and streams it live, exactly as if a peer window had sent it. The message
 * carries `metadata.workflowResult` so the UI can render it as a workflow-result
 * card instead of a user bubble.
 */

import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { handleChat } from '../ai/chat-flow.js'
import { getChatHistoryService, getChatStorage } from '../ai/state.js'
import { getLiveTurnStatus, subscribeLiveTurnPresence } from '../ai/live-turn-hub.js'
import { readRunResult } from './store.js'
import type { WorkflowRunView } from './types.js'

/** Cap the inlined result so one huge output can't blow up the next turn's context. */
const MAX_RESULT_CHARS = 20_000
/** How long to wait for an in-flight turn in that chat before giving up. */
const BUSY_TIMEOUT_MS = 15 * 60_000

/** Metadata marking a delivered workflow result — the UI keys its card off this. */
export interface WorkflowResultMetadata {
  runId: string
  name: string
  status: string
}

function formatResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n...(truncated)` : text
}

/**
 * The text the model reads. Tagged rather than prosaic so a long result can't be
 * mistaken for instructions, and so the model can tell a completed run from a
 * failed one without parsing English.
 */
function buildText(run: WorkflowRunView, resultText: string | null): string {
  const head = `A background workflow ${run.status === 'completed' ? 'finished' : 'ended'}:\n` +
    `<workflow-result>\n<name>${run.name}</name>\n<status>${run.status}</status>\n`
  if (run.status === 'completed') {
    const body = resultText != null ? `<result>\n${resultText}\n</result>` : '<result>(no result captured)</result>'
    return `${head}${body}\n</workflow-result>\nUse this result to continue.`
  }
  const reason = run.error ? `\n<error>${run.error}</error>` : ''
  return `${head}${reason}\n</workflow-result>\nThe workflow did not complete; decide how to proceed.`
}

/**
 * Resolve once the chat has no turn running.
 *
 * Starting a second turn preempts the first — the node aborts the running
 * request — so delivering into a chat that is mid-reply would truncate whatever
 * the user is reading. Waiting is the whole point of a background run: nothing
 * is lost by landing a minute later.
 */
function waitForIdle(chatId: number, signal?: AbortSignal): Promise<boolean> {
  if (!getLiveTurnStatus(chatId).active) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(false), BUSY_TIMEOUT_MS)
    const unsubscribe = subscribeLiveTurnPresence(chatId, (status) => {
      if (!status.active) done(true)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Feed a terminal run's result back into its launching conversation.
 *
 * No-ops when the run has no chat (launched outside a conversation) or that chat
 * is gone — a deleted conversation is not an error, it just means there is no
 * one left to tell. Never throws: this runs in the workflow's `finally`, where a
 * failure to deliver must not also lose the run's terminal bookkeeping.
 */
export async function deliverWorkflowResult(run: WorkflowRunView, signal?: AbortSignal): Promise<void> {
  const chatId = run.chatId ?? 0
  if (chatId <= 0) return
  try {
    const meta = getChatHistoryService()?.getChatMeta(chatId)
    if (!meta) return // conversation deleted while the workflow ran

    // The view deliberately omits the result (it can be large); read it from the
    // run's `settled` event only when there is actually one to deliver.
    const stored = run.status === 'completed' && run.hasResult ? readRunResult(run.runId) : undefined
    const resultText = stored?.hasResult ? formatResult(stored.result) : null
    const message: UIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: buildText(run, resultText) }],
      metadata: {
        workflowResult: { runId: run.runId, name: run.name, status: run.status } satisfies WorkflowResultMetadata,
      },
    }

    if (!(await waitForIdle(chatId, signal))) return

    const response = await handleChat({
      requestId: `workflow-${run.runId}`,
      chatId,
      messages: [message],
      providerId: meta.providerId,
      modelId: meta.model,
      modeId: meta.metadata?.modeId,
      thinkingLevel: meta.thinkingLevel,
      workspaceId: meta.workspaceId,
    })
    // Drain our own branch. The bytes that matter went to the live-turn hub via
    // tee inside handleChat; this side just has to not hold the stream open.
    await response.body?.cancel().catch(() => {})
  } catch (error) {
    console.warn(
      `[workflow] could not deliver result of ${run.runId} to chat ${chatId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

/** True when a chat still exists — used to skip delivery for deleted conversations. */
export function chatExists(chatId: number): boolean {
  return !!getChatStorage()?.getChatMeta(chatId)
}
