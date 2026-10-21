/**
 * The write side of one run.
 *
 * A run's log holds what happened to the run — phases, agent rows, approvals,
 * logs, the outcome. What an agent said is not in it: every sub-agent runs as a
 * chat of its own (see `dispatch.ts`), and its row names that chat. That is why
 * there is no buffering and no size cap here any more; the per-token output that
 * needed both now lives where every other conversation does.
 */

import { appendEvent } from './store.js'
import type { WorkflowEvent } from './events.js'

export class RunEventWriter {
  readonly runId: string
  private disposed = false

  constructor(runId: string) {
    this.runId = runId
  }

  /** Append a run-level event. */
  emit(event: WorkflowEvent): void {
    if (this.disposed) return
    appendEvent(this.runId, event)
  }

  /** The writer accepts nothing afterwards. */
  dispose(): void {
    this.disposed = true
  }
}
