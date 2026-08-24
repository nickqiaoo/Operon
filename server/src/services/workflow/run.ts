/**
 * A workflow run's lifecycle, start to settle — in one place.
 *
 * This used to be spread across the MCP route (created the state), an execute
 * helper (persisted it), the registry (owned aborts), the hub (owned events) and
 * the completion module (delivered the result), with the run object passed
 * between them and mutated by each. Now the route decides only WHETHER to start
 * a run, and everything that happens to one happens here, as appends.
 */

import {
  WorkflowJournal,
  runWorkflow,
  type WorkflowMeta,
} from 'operon-agents'
import { deliverWorkflowResult } from './completion.js'
import { buildHooks, type WorkflowRunContext } from './engine-hooks.js'
import { workflowJournalStore } from './journal-store.js'
import { registerWorkflowAbort, unregisterWorkflowAbort } from './registry.js'
import {
  appendEvent,
  markExecuting,
  pruneRuns,
  readRunView,
  unmarkExecuting,
} from './store.js'
import { RunEventWriter } from './writer.js'

/**
 * How many runs are kept. Beyond this the oldest settled runs are deleted with
 * their entire event log — the only retention rule, applied in the only place
 * runs are stored.
 */
const KEEP_RUNS = 200

export interface StartRunParams {
  ctx: WorkflowRunContext
  runId: string
  meta: WorkflowMeta
  /** The resolved script, recorded so the run can be resumed later. */
  script: string
  scriptBody: string
  args: unknown
  /** True when re-running an existing runId to replay its journal. */
  resumed: boolean
}

/**
 * Record the run and start it detached. Returns as soon as it is visible.
 *
 * ALWAYS detached, on purpose. A workflow is minutes of work across several
 * agents and an MCP tool call is a single HTTP request: every client has its own
 * timeout, and the ones that fire kill the call while the run keeps going, so the
 * model is told "timed out" about work that is in fact still running. It also
 * blocks the conversation, and until the call returns there is no runId — so the
 * panel cannot show the very run the user is waiting for.
 */
export function startRun(params: StartRunParams): void {
  // Appended synchronously: when this function returns, the run exists, the panel
  // has been told, and a resume can find its script — even if the process dies in
  // the next tick.
  appendEvent(params.runId, {
    kind: 'started',
    chatId: params.ctx.chatId ?? null,
    name: params.meta.name,
    description: params.meta.description,
    script: params.script,
    args: params.args,
    startedAt: Date.now(),
    resumed: params.resumed,
  })
  void executeRun(params)
}

async function executeRun(params: StartRunParams): Promise<void> {
  const { runId } = params
  const controller = new AbortController()
  const writer = new RunEventWriter(runId)

  markExecuting(runId)
  registerWorkflowAbort(runId, controller)

  try {
    // The resume journal is a view over this run's own event log — same table,
    // same append path, no separate store. The framework's WorkflowJournal runs
    // unchanged behind a SessionStore shim.
    const journal = new WorkflowJournal(runId, workflowJournalStore(runId))
    await journal.load()

    const hooks = buildHooks(params.ctx, writer, controller)
    let status: 'completed' | 'failed' | 'stopped' = 'completed'
    let result: unknown
    let error: string | undefined
    let failures: string[] = []

    try {
      const outcome = await runWorkflow({
        meta: params.meta,
        scriptBody: params.scriptBody,
        args: params.args,
        hooks,
        journal,
      })
      failures = outcome.failures
      if (controller.signal.aborted) {
        status = 'stopped'
      } else if (outcome.ok) {
        result = outcome.result
      } else {
        status = 'failed'
        error = outcome.error
      }
    } catch (err) {
      // runWorkflow THROWS on abort (WorkflowAbortedError) — that is a stop, not
      // a failure, and must not be reported to the user as one.
      if (controller.signal.aborted) {
        status = 'stopped'
      } else {
        status = 'failed'
        error = err instanceof Error ? err.message : String(err)
      }
    }

    // Flush any buffered sub-agent output BEFORE the terminal event, so the log
    // reads in real order and `settled` is genuinely the last thing in it.
    writer.flush()
    appendEvent(runId, { kind: 'settled', status, endedAt: Date.now(), error, failures, result })
  } finally {
    writer.dispose()
    unregisterWorkflowAbort(runId)
    unmarkExecuting(runId)

    const view = readRunView(runId)
    if (view) {
      // Detached: delivery waits for the launching chat to go idle, which can
      // take minutes, and terminal bookkeeping must not wait for that.
      void deliverWorkflowResult(view)
    }
    try {
      pruneRuns(KEEP_RUNS)
    } catch (err) {
      console.warn(`[workflow] retention pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
