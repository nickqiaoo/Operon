/**
 * Read side of the workflow event log — the panel's two feeds and three lookups.
 *
 * Every reader here folds the log (via `services/workflow/store.ts`); none keeps
 * state of its own, and there is no live-versus-durable merge to get wrong,
 * because there is no longer a live copy to merge.
 *
 * The feed contract is deliberately small and identical in both scopes:
 *   `sync`  — the current truth, sent on connect, with the cursor it was read at
 *   `run`   — this run's view changed (already folded server-side)
 *   `chunk` — sub-agent output (run-scoped feeds only; the panel list has no use
 *             for it and it is by far the highest-volume kind)
 *
 * Every frame carries the event id it came from, so a client that reconnects
 * passes `since=<last id>` and receives exactly what it missed — including a
 * running agent's earlier output, which the old hub-only design could not
 * replay at all.
 */

import { abortWorkflow } from '../workflow/registry.js'
import { subscribeWorkflowEvents } from '../workflow/hub.js'
import {
  lastEventId,
  listRunViews,
  listRunningRunViews,
  readAgentChunks,
  readRunEvents,
  readRunResult,
  readRunScript,
  readRunView,
} from '../workflow/store.js'
import { VIEW_EXCLUDED_KINDS, type StoredWorkflowEvent } from '../workflow/events.js'
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
 * One sub-agent's recorded output, as the raw chunk array the panel's reducer
 * consumes — the same frames the live feed carries, so a finished run and a
 * running one render through exactly one code path.
 */
export function getWorkflowAgentChunks(
  runId: string,
  agentIndex: number,
): { chunks: unknown[]; truncated: boolean } {
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

/** Frame for one live event on a run-scoped feed, or null if it carries nothing. */
function runFrame(event: StoredWorkflowEvent): unknown | null {
  if (event.event.kind === 'chunk') {
    return { t: 'chunk', runId: event.runId, index: event.event.index, chunks: event.event.chunks, id: event.id }
  }
  if (event.event.kind === 'journal') return null
  const run = readRunView(event.runId)
  return run ? { t: 'run', run, id: event.id } : null
}

/**
 * Replay a backlog of events.
 *
 * Chunks go out one frame each — they accumulate, so every one matters. Run-level
 * events do NOT: each would fold to the same current view, so fifty of them would
 * mean fifty copies of the whole run down the wire. One at the end says the same
 * thing.
 */
function enqueueBacklog(
  controller: ReadableStreamDefaultController<Uint8Array>,
  runId: string,
  backlog: readonly StoredWorkflowEvent[],
): void {
  let lastViewId: number | null = null
  for (const event of backlog) {
    if (event.event.kind === 'chunk') {
      controller.enqueue(
        sseFrame({ t: 'chunk', runId, index: event.event.index, chunks: event.event.chunks, id: event.id }),
      )
    } else if (event.event.kind !== 'journal') {
      lastViewId = event.id
    }
  }
  if (lastViewId == null) return
  const run = readRunView(runId)
  if (run) controller.enqueue(sseFrame({ t: 'run', run, id: lastViewId }))
}

/**
 * One run's feed, including its sub-agents' output.
 *
 * With `since`, sends only what came after that id — the reconnect path. Without
 * it, replays the run's whole log first: that is how a panel opened (or
 * refreshed) mid-run shows what a still-running agent has already said, which
 * previously existed only as SSE frames nobody had been listening for.
 *
 * Returns undefined (→ 404) for a run that was never started.
 */
export function getWorkflowRunFeed(runId: string, since?: number): ReadableStream<Uint8Array> | undefined {
  const view = readRunView(runId)
  if (!view) return undefined
  let unsubscribe: (() => void) | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cursor = lastEventId()
      if (since == null) {
        controller.enqueue(sseFrame({ t: 'sync', run: view, id: cursor }))
      }
      enqueueBacklog(controller, runId, readRunEvents(runId, since))

      // A finished run has nothing more to say. Close rather than hold a
      // connection open for events that will never come.
      if (view.status !== 'running') {
        controller.close()
        return
      }

      unsubscribe = subscribeWorkflowEvents(runId, (event) => {
        // Everything up to `cursor` is already in the backlog above.
        if (event.id <= cursor) return
        const frame = runFrame(event)
        if (!frame) return
        try {
          controller.enqueue(sseFrame(frame))
        } catch {
          return
        }
        if (event.event.kind === 'settled') {
          unsubscribe?.()
          unsubscribe = null
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
      })
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = null
    },
  })
}
