/**
 * The workflow event vocabulary — the only thing that is ever written.
 *
 * Every fact about a run is one of these, appended in order. Nothing about a run
 * is stored any other way: the panel's view, a sub-agent's transcript, the resume
 * journal and the final result are all folds over this sequence (see `fold.ts`,
 * `store.ts`, and migration 0038 for why).
 *
 * Two rules keep that true:
 *   - events are FACTS, never derived state — `agent` carries the patch that
 *     changed, not the merged row, so replaying is deterministic;
 *   - anything a reader needs must be IN an event. If the panel wants to show it,
 *     something has to have emitted it.
 */

import type { WorkflowAgentRecord, WorkflowPendingApproval, WorkflowRunStatus } from './types.js'

/** Everything that can happen to a run, in the order it happened. */
export type WorkflowEvent =
  /** Always first. Carries the run's identity + what resume needs to re-run it. */
  | {
      kind: 'started'
      chatId: number | null
      name: string
      description: string
      /** The resolved script — read back by `resumeFromRunId`. */
      script: string
      /** JSON-safe run args, if any. */
      args?: unknown
      startedAt: number
      /** True when this run is a resume of an earlier attempt under the same id. */
      resumed?: boolean
    }
  | { kind: 'phase'; index: number; title: string; phaseKind?: 'normal' | 'child' }
  /**
   * A partial update to one sub-agent. Patches, not snapshots: the engine knows
   * label/state/result, the host knows which agent type ran it and for how long,
   * and neither should overwrite the other's fields with undefined.
   */
  | { kind: 'agent'; index: number; patch: Partial<WorkflowAgentRecord> }
  /**
   * A batch of a sub-agent's raw UIMessageChunks, in arrival order. Batched
   * because one event per token would be one INSERT per token; the fold does not
   * care how they were grouped.
   */
  | { kind: 'chunk'; index: number; chunks: unknown[] }
  /** This sub-agent's recording hit its byte cap; later chunks are not kept. */
  | { kind: 'truncated'; index: number }
  | { kind: 'approval'; approval: WorkflowPendingApproval }
  | { kind: 'approval-resolved'; approvalId: string }
  | { kind: 'log'; message: string }
  /**
   * One framework `AgentRecord` from the resume journal, verbatim. The framework
   * writes these through a SessionStore shim (`sqlite-session-store.ts`) and reads
   * them back on resume — this is the whole journal, with no table of its own.
   */
  | { kind: 'journal'; addr: string; record: unknown }
  /** Terminal. Carries the final result so nothing else has to store it. */
  | {
      kind: 'settled'
      status: Exclude<WorkflowRunStatus, 'running'>
      endedAt: number
      error?: string
      failures?: string[]
      result?: unknown
    }

export type WorkflowEventKind = WorkflowEvent['kind']

/** A persisted event: the event itself plus its position in the log. */
export interface StoredWorkflowEvent {
  id: number
  runId: string
  ts: number
  event: WorkflowEvent
}

/**
 * Kinds excluded when folding a run view.
 *
 * `chunk` is the only high-volume kind (one per token, batched); every list and
 * view read skips it, which is what keeps folding cheap enough to do on demand
 * instead of maintaining a second copy of run state.
 */
export const VIEW_EXCLUDED_KINDS: readonly WorkflowEventKind[] = ['chunk', 'journal']
