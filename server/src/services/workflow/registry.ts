/**
 * Abort controllers for in-flight runs.
 *
 * All that is left of what used to be "the run registry". Run STATE is no longer
 * held in memory at all — it is folded from the event log on demand (`store.ts`),
 * which removed both the leak (runs were added to a map and never removed) and
 * the rule that made it dangerous ("the live map overlays the durable row", so a
 * stale in-memory copy silently won over the database).
 *
 * An AbortController genuinely cannot be persisted: it is a handle on work
 * happening in THIS process. When the process dies, so does the run — which the
 * startup sweep records as `interrupted`.
 */

const workflowAborts = new Map<string, AbortController>()

export function registerWorkflowAbort(runId: string, controller: AbortController): void {
  workflowAborts.set(runId, controller)
}

export function unregisterWorkflowAbort(runId: string): void {
  workflowAborts.delete(runId)
}

/** Abort a running workflow by id. Returns true if a live run was found + aborted. */
export function abortWorkflow(runId: string): boolean {
  const controller = workflowAborts.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}
