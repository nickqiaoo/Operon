/**
 * events → view. The only interpreter of the event log.
 *
 * Pure and total: hand it any prefix of a run's events and it returns what the
 * panel should show at that point. Nothing else in the system is allowed to know
 * how a run's state is assembled — that is what stops "the live copy says X, the
 * durable copy says Y" from ever being a question again.
 *
 * Folding is done on demand rather than maintained incrementally because it is
 * cheap: `chunk` events (the only high-volume kind) are excluded, leaving a
 * handful of rows per agent.
 */

import type { StoredWorkflowEvent } from './events.js'
import type { WorkflowAgentRecord, WorkflowRunView } from './types.js'

/**
 * Fold one run's events into its view.
 *
 * Returns undefined when the sequence has no `started` event — a run is defined
 * by having been started, and a log without one is a fragment (a pruned tail, a
 * corrupt row), not a run with defaults.
 *
 * `chunk` and `journal` events are ignored here; pass them or not, it makes no
 * difference to the result.
 */
export function foldRunView(runId: string, events: readonly StoredWorkflowEvent[]): WorkflowRunView | undefined {
  let view: WorkflowRunView | undefined
  /** Agents keyed by index so patches merge in place, in first-seen order. */
  const agents = new Map<number, WorkflowAgentRecord>()

  for (const { event } of events) {
    switch (event.kind) {
      case 'started':
        view = {
          runId,
          taskId: runId,
          chatId: event.chatId,
          name: event.name,
          description: event.description,
          status: 'running',
          phases: [],
          agents: [],
          pendingApprovals: [],
          logs: [],
          failures: [],
          startedAt: event.startedAt,
          hasResult: false,
        }
        // A resume re-appends `started` under the same runId. Keep the agents
        // already folded from the first attempt: the ones the journal replays are
        // never re-run, so their only record of having happened is that history.
        break

      case 'phase': {
        if (!view) break
        if (view.phases.some((p) => p.index === event.index)) break
        view.phases.push({ index: event.index, title: event.title, kind: event.phaseKind })
        break
      }

      case 'agent': {
        if (!view) break
        const existing = agents.get(event.index)
        if (existing) {
          // Patch semantics: only keys the emitter actually set. An engine event
          // (label/state/result) must not blank the host's fields (agentType,
          // timings), and vice versa.
          Object.assign(existing, event.patch)
        } else {
          agents.set(event.index, {
            index: event.index,
            taskId: `${runId}-a${event.index}`,
            label: event.patch.label ?? `agent ${event.index}`,
            state: event.patch.state ?? 'queued',
            ...event.patch,
          })
        }
        break
      }

      case 'truncated': {
        const agent = agents.get(event.index)
        if (agent) agent.truncated = true
        break
      }

      case 'approval': {
        if (!view) break
        if (view.pendingApprovals.some((a) => a.approvalId === event.approval.approvalId)) break
        view.pendingApprovals.push(event.approval)
        break
      }

      case 'approval-resolved': {
        if (!view) break
        view.pendingApprovals = view.pendingApprovals.filter((a) => a.approvalId !== event.approvalId)
        break
      }

      case 'log': {
        if (!view) break
        // Narration, not failure. These used to be appended to `failures`, which
        // rendered a successful run's own `log()` lines under a red "Failures"
        // heading — the script saying "sending a prompt…" looked like something
        // had gone wrong. Real failures arrive on `settled`.
        view.logs.push(event.message)
        break
      }

      case 'settled': {
        if (!view) break
        view.status = event.status
        view.endedAt = event.endedAt
        if (event.error) view.error = event.error
        if (event.failures?.length) view.failures.push(...event.failures)
        view.hasResult = event.result !== undefined
        // Whatever a sub-agent was waiting for, nobody is going to answer it now.
        view.pendingApprovals = []
        break
      }

      case 'chunk':
      case 'journal':
        break
    }
  }

  if (!view) return undefined
  view.agents = [...agents.values()].sort((a, b) => a.index - b.index)

  // Note what this fold deliberately does NOT decide: whether a run marked
  // `running` is actually running (its process may have died — the startup sweep
  // appends `settled: interrupted` for those), and whether a pending approval is
  // still answerable (the promise it resolves lives in the process that created
  // it — `store.ts` drops approvals for runs it is not executing). Both are facts
  // about the world, not about the log, so neither belongs here.
  return view
}

/** Split a mixed event stream by run, preserving order within each run. */
export function groupEventsByRun(
  events: readonly StoredWorkflowEvent[],
): Map<string, StoredWorkflowEvent[]> {
  const byRun = new Map<string, StoredWorkflowEvent[]>()
  for (const event of events) {
    const list = byRun.get(event.runId)
    if (list) list.push(event)
    else byRun.set(event.runId, [event])
  }
  return byRun
}
