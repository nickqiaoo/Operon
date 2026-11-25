/**
 * Read side of the workflow event log — the panel's feed and its lookups.
 *
 * Every reader here folds the log (via `services/workflow/store.ts`); none keeps
 * state of its own, and there is no live-versus-durable merge to get wrong,
 * because there is no longer a live copy to merge.
 *
 * The feed carries run views only:
 *   `sync` — the runs in flight, sent on connect, with the cursor it was read at
 *   `run`  — a run's view changed (already folded server-side)
 *
 * A sub-agent's output is not on it. The agent runs as a chat: the panel reads
 * what it has saved through `getWorkflowAgentChunks` and watches a running turn
 * on the chat's own turn stream, like any chat. Runs from before agents ran as
 * chats have their output as `chunk` events in the log, read the same way.
 */

import { abortWorkflow } from '../workflow/registry.js'
import { subscribeWorkflowEvents } from '../workflow/hub.js'
import {
  lastEventId,
  listRunViews,
  listRunningRunViews,
  readAgentChunks,
  readRunResult,
  readRunScript,
  readRunView,
} from '../workflow/store.js'
import { VIEW_EXCLUDED_KINDS } from '../workflow/events.js'
import { readAgentChatChunks } from '../workflow/agent-chats.js'
import type { WorkflowRunView } from '../workflow/types.js'

export type { WorkflowRunView }

/** Stop an in-flight workflow run. Returns whether a live run was found + aborted. */
export function stopWorkflow(runId: string): { stopped: boolean } {
  return { stopped: abortWorkflow(runId) }
}

export function getWorkflowResult(runId: string): { hasResult: boolean; result?: unknown } {
  return readRunResult(runId)
}

/**
 * The script a run was launched with, from its `started` event.
 *
 * Kept off the run view: it is the largest field on a run and every list read
 * would carry it, while it is only ever wanted for one run the user opened.
 */
export function getWorkflowScript(runId: string): { script?: string; args?: unknown } {
  return readRunScript(runId) ?? {}
}

/**
 * One sub-agent's output, as the raw chunk array the panel's reducer consumes.
 *
 * An agent that ran as a chat is read from that chat (and its turn stream, while
 * it is going — unless `settled`, for a reader watching that stream itself). One
 * recorded before agents ran as chats still has its output in the run's own log.
 */
export function getWorkflowAgentChunks(
  runId: string,
  agentIndex: number,
  options: { settled?: boolean } = {},
): { chunks: unknown[]; truncated: boolean } {
  const chatIds = readRunView(runId)?.agents.find((agent) => agent.index === agentIndex)?.chatIds
  if (chatIds?.length) return { chunks: readAgentChatChunks(chatIds, options), truncated: false }
  return readAgentChunks(runId, agentIndex)
}

export function listWorkflowRuns(limit = 50): WorkflowRunView[] {
  return listRunViews(limit)
}

export function getWorkflowRun(runId: string): WorkflowRunView | undefined {
  return readRunView(runId)
}

const encoder = new TextEncoder()
const sseFrame = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * The panel's global feed: what is RUNNING, kept current.
 *
 * Chunks are filtered out — the list shows runs, not sub-agent output, and
 * forwarding every token to every open panel would be the most expensive thing
 * this app does for no visible gain.
 *
 * The opening `sync` carries in-flight runs only, NOT recent history. This feed
 * is mounted for the whole session by everything that has to notice a run
 * needing a human — it is not the panel's data source. History is a thing the
 * user asks to see, so the panel fetches it from `/ai/workflow/runs` when it
 * opens, and until then nothing is folded on its behalf.
 *
 * A `run` frame carries the KIND of the event that produced it. Without it the
 * client cannot tell "this run just started" from "this run was already going
 * when you connected", and the UI that raises the workflow panel on a new run
 * has to guess. The kind is a fact this side already has.
 */
export function getWorkflowFeed(limit = 50): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Cursor read BEFORE the snapshot: an event landing between the two is
      // re-sent rather than missed. Duplicates are harmless (a run frame is a
      // whole view), a gap would not be.
      const since = lastEventId()
      controller.enqueue(sseFrame({ t: 'sync', runs: listRunningRunViews().slice(0, limit), id: since }))

      unsubscribe = subscribeWorkflowEvents(null, (event) => {
        if (VIEW_EXCLUDED_KINDS.includes(event.event.kind)) return
        const run = readRunView(event.runId)
        if (!run) return
        try {
          controller.enqueue(sseFrame({ t: 'run', run, id: event.id, kind: event.event.kind }))
        } catch {
          // client went away between the event and the write
        }
      })
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = null
    },
  })
}
