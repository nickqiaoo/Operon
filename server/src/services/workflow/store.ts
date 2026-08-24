/**
 * The workflow store — the ONLY door to workflow persistence.
 *
 * Everything above it (the MCP tool, the run lifecycle, the read side, the SSE
 * endpoints) talks to this module and never to SQLite, and nothing keeps its own
 * copy of run state. Appending is the single way anything changes; reading is
 * always a fold over what was appended.
 *
 * The one piece of mutable memory here is `viewCache`, and it is a cache in the
 * strict sense: dropped freely, always rebuildable by re-folding the log. It
 * exists because a run view is re-read on every event (each SSE frame carries
 * the fresh view) and re-folding from SQLite each time would be wasteful — not
 * because anything is stored there.
 */

import type { ChatStorageAdapter, WorkflowEventInput } from '../../storage/interface.js'
import { getChatStorage } from '../ai/state.js'
import { VIEW_EXCLUDED_KINDS, type StoredWorkflowEvent, type WorkflowEvent } from './events.js'
import { foldRunView, groupEventsByRun } from './fold.js'
import { publishWorkflowEvent } from './hub.js'
import type { WorkflowRunView } from './types.js'

/** Folded views, keyed by runId. Invalidated on any event that can change one. */
const viewCache = new Map<string, WorkflowRunView>()

/** Runs whose execution lives in THIS process — see `clearStaleApprovals`. */
const executingRuns = new Set<string>()

function storage(): ChatStorageAdapter | null {
  return getChatStorage()
}

function parseEvent(row: { id: number; runId: string; ts: number; data: string }): StoredWorkflowEvent | null {
  try {
    return { id: row.id, runId: row.runId, ts: row.ts, event: JSON.parse(row.data) as WorkflowEvent }
  } catch {
    // A corrupt row is skipped rather than failing the whole fold: losing one
    // event degrades a view, losing the run loses the user's work log.
    return null
  }
}

/**
 * Persist events, update the derived index, and tell live readers — in that
 * order, so nothing is ever published before it is durable.
 */
export function appendEvents(runId: string, events: WorkflowEvent[]): void {
  if (events.length === 0) return
  const db = storage()
  if (!db) return

  const ts = Date.now()
  const rows: WorkflowEventInput[] = events.map((event) => ({
    runId,
    ts,
    kind: event.kind,
    data: JSON.stringify(event),
  }))

  let lastId: number
  try {
    lastId = db.appendWorkflowEvents(rows)
  } catch (error) {
    // Never let a write failure take down a running workflow: the run keeps
    // going, it just stops being observable. Loud, because that is a real loss.
    console.warn(
      `[workflow] could not append ${events.length} event(s) for ${runId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return
  }

  // Any event other than a chunk can change the folded view.
  if (events.some((event) => !VIEW_EXCLUDED_KINDS.includes(event.kind))) {
    viewCache.delete(runId)
    syncIndex(runId)
  }

  // Ids are assigned in insertion order, so the last row's id minus the batch
  // size recovers each event's own id without a second query.
  const firstId = lastId - events.length + 1
  events.forEach((event, i) => {
    publishWorkflowEvent({ id: firstId + i, runId, ts, event })
  })
}

/** Convenience for the common one-event case. */
export function appendEvent(runId: string, event: WorkflowEvent): void {
  appendEvents(runId, [event])
}

/** Refresh the derived index row from the freshly folded view. */
function syncIndex(runId: string): void {
  const db = storage()
  const view = readRunView(runId)
  if (!db || !view) return
  db.upsertWorkflowRunIndex({
    runId,
    chatId: view.chatId ?? null,
    name: view.name,
    status: view.status,
    startedAt: view.startedAt,
    endedAt: view.endedAt ?? null,
  })
}

/**
 * A run's current view, folded from its log.
 *
 * Approvals are dropped for any run this process is not executing: the pending
 * request's promise lives in the process that created it, so after a restart the
 * button would answer nothing. Better to show none than to show a dead one.
 */
export function readRunView(runId: string): WorkflowRunView | undefined {
  const cached = viewCache.get(runId)
  if (cached) return cached
  const db = storage()
  if (!db) return undefined
  const events = db
    .readWorkflowEvents(runId, { excludeKinds: [...VIEW_EXCLUDED_KINDS] })
    .map(parseEvent)
    .filter((event): event is StoredWorkflowEvent => event !== null)
  const view = foldRunView(runId, events)
  if (!view) return undefined
  if (!executingRuns.has(runId)) view.pendingApprovals = []
  viewCache.set(runId, view)
  return view
}

/**
 * Views for `runIds`, in the order given, folding only what is not cached.
 *
 * One read for all of them rather than one per run — the callers below pass a
 * whole page of ids, and per-run reads would make listing cost scale with the
 * page instead of with the misses.
 */
function foldRunViews(runIds: readonly string[]): WorkflowRunView[] {
  const db = storage()
  if (!db) return []
  const missing = runIds.filter((runId) => !viewCache.has(runId))

  if (missing.length > 0) {
    const grouped = groupEventsByRun(
      db
        .readWorkflowEventsForRuns(missing, { excludeKinds: [...VIEW_EXCLUDED_KINDS] })
        .map(parseEvent)
        .filter((event): event is StoredWorkflowEvent => event !== null),
    )
    for (const runId of missing) {
      const view = foldRunView(runId, grouped.get(runId) ?? [])
      if (!view) continue
      if (!executingRuns.has(runId)) view.pendingApprovals = []
      viewCache.set(runId, view)
    }
  }

  return runIds
    .map((runId) => viewCache.get(runId))
    .filter((view): view is WorkflowRunView => view !== undefined)
}

/**
 * Recent runs, newest first.
 *
 * Two queries regardless of how many runs: the index picks and orders them, then
 * one read folds all their events together. Cached views short-circuit the fold.
 */
export function listRunViews(limit = 50): WorkflowRunView[] {
  const db = storage()
  if (!db) return []
  return foldRunViews(db.listWorkflowRunIndex(limit).map((row) => row.runId))
}

/**
 * Runs that are still going, in no particular order.
 *
 * Separate from `listRunViews` because the two answer different questions, and
 * the global feed only ever needed this one: what is in flight right now. After
 * the startup sweep marks the previous process's leftovers `interrupted`, a cold
 * start has none, so the feed opens without folding anything at all.
 */
export function listRunningRunViews(): WorkflowRunView[] {
  const db = storage()
  if (!db) return []
  return foldRunViews(db.listRunningWorkflowRunIds())
}

/** The script + args a resume needs, from the run's `started` event. */
export function readRunScript(runId: string): { script: string; args?: unknown } | undefined {
  const db = storage()
  if (!db) return undefined
  // The LAST started event: a resumed run appends another, and its script is the
  // one that actually ran.
  const rows = db.readWorkflowEvents(runId, { kinds: ['started'] })
  const parsed = rows.map(parseEvent).filter((event): event is StoredWorkflowEvent => event !== null)
  const started = parsed[parsed.length - 1]?.event
  if (started?.kind !== 'started') return undefined
  return { script: started.script, args: started.args }
}

/** The final result, from the run's `settled` event. */
export function readRunResult(runId: string): { hasResult: boolean; result?: unknown } {
  const db = storage()
  if (!db) return { hasResult: false }
  const rows = db.readWorkflowEvents(runId, { kinds: ['settled'] })
  const parsed = rows.map(parseEvent).filter((event): event is StoredWorkflowEvent => event !== null)
  const settled = parsed[parsed.length - 1]?.event
  if (settled?.kind !== 'settled' || settled.result === undefined) return { hasResult: false }
  return { hasResult: true, result: settled.result }
}

/**
 * One sub-agent's recorded output, flattened back into the arrival-order chunk
 * array the panel's reducer consumes — the same frames the live stream carried,
 * so a finished run renders through exactly one code path.
 */
export function readAgentChunks(runId: string, agentIndex: number): { chunks: unknown[]; truncated: boolean } {
  const db = storage()
  if (!db) return { chunks: [], truncated: false }
  const chunks: unknown[] = []
  let truncated = false
  for (const row of db.readWorkflowEvents(runId, { kinds: ['chunk', 'truncated'] })) {
    const parsed = parseEvent(row)
    if (!parsed) continue
    if (parsed.event.kind === 'chunk' && parsed.event.index === agentIndex) {
      chunks.push(...parsed.event.chunks)
    } else if (parsed.event.kind === 'truncated' && parsed.event.index === agentIndex) {
      truncated = true
    }
  }
  return { chunks, truncated }
}

/** Raw events for a run, for a reader catching up from `sinceId`. */
export function readRunEvents(runId: string, sinceId?: number): StoredWorkflowEvent[] {
  const db = storage()
  if (!db) return []
  return db
    .readWorkflowEvents(runId, { sinceId })
    .map(parseEvent)
    .filter((event): event is StoredWorkflowEvent => event !== null)
}

/** The log's high-water mark — the cursor a fresh subscriber tails from. */
export function lastEventId(): number {
  return storage()?.lastWorkflowEventId() ?? 0
}

/** Mark a run as executing here, so its live approvals are shown. */
export function markExecuting(runId: string): void {
  executingRuns.add(runId)
  viewCache.delete(runId)
}

export function unmarkExecuting(runId: string): void {
  executingRuns.delete(runId)
  viewCache.delete(runId)
}

/**
 * Startup sweep: settle every run still marked `running`.
 *
 * Their process is gone, so they are not running — but nothing appended a
 * terminal event before it died. Recorded as an ordinary `settled` event with
 * status `interrupted` (resumable via `resumeFromRunId`) rather than as a
 * special case, so the fold needs no notion of "was interrupted".
 */
export function sweepInterruptedRuns(): number {
  const db = storage()
  if (!db) return 0
  const runIds = db.listRunningWorkflowRunIds()
  for (const runId of runIds) {
    appendEvent(runId, { kind: 'settled', status: 'interrupted', endedAt: Date.now() })
  }
  return runIds.length
}

/**
 * Retention. Runs are kept newest-first; everything past `keep` is deleted from
 * the log and the index together.
 */
export function pruneRuns(keep: number): number {
  const removed = storage()?.pruneWorkflowRuns(keep) ?? 0
  if (removed > 0) viewCache.clear()
  return removed
}

/** Test seam: forget every cached fold. */
export function clearViewCache(): void {
  viewCache.clear()
}
