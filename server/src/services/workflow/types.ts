/**
 * Workflow view types — the shapes the panel speaks.
 *
 * These are DERIVED: every one of them is produced by folding the event log
 * (`fold.ts`), never stored. The workflow ENGINE types (WorkflowMeta,
 * WorkflowHostHooks, …) are not redefined here — the MCP tool imports them from
 * `operon-agents`, which is used as a library and never modified.
 */

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

/** One sub-agent execution, as folded from its `agent` patches. */
export interface WorkflowAgentRecord {
  index: number
  taskId: string
  label: string
  phase?: string
  state: 'queued' | 'running' | 'done' | 'error'
  resultPreview?: string
  error?: string
  /**
   * Host-side facts the engine has no notion of. `agentType` in particular is the
   * whole point of this workflow — which of the user's agents actually ran this
   * step.
   */
  agentType?: string
  modelId?: string
  startedAt?: number
  endedAt?: number
  /** This agent's recorded output hit the byte cap; its tail is missing. */
  truncated?: boolean
}

export interface WorkflowProgressPhase {
  index: number
  title: string
  kind?: 'normal' | 'child'
}

/**
 * A sub-agent request that needs a human — surfaced on the run itself.
 *
 * The run panel is where the user launched this work and where they are already
 * watching it, so a blocked sub-agent has to be visible and answerable THERE.
 * The approval inbox carries the same request as a fallback, and both answer
 * through the ordinary permission response — see `services/agents/detached-approvals.ts`.
 */
export interface WorkflowPendingApproval {
  approvalId: string
  /** Sub-agent that asked, e.g. 'codex-a3'. */
  agentId: string
  toolName: string
  /** The asking tool's input — an AskUserQuestion's `questions`, with options. */
  toolInput?: unknown
  requestedAt: number
}

/**
 * A run as the panel sees it.
 *
 * Deliberately excludes the final result: it can be large, it is not needed to
 * render a row, and it has its own endpoint. `hasResult` says whether asking is
 * worth it.
 *
 * `pendingApprovals` survives a fold but NOT a restart — the promises those
 * requests would resolve live in the process that started them, so a rebuilt
 * view of an interrupted run shows no answerable buttons (see `fold.ts`).
 */
export interface WorkflowRunView {
  runId: string
  taskId: string
  /** The chat that launched this run — the result routes back there. */
  chatId?: number | null
  name: string
  description: string
  status: WorkflowRunStatus
  phases: WorkflowProgressPhase[]
  agents: WorkflowAgentRecord[]
  pendingApprovals: WorkflowPendingApproval[]
  /**
   * `log()` output from the script, plus host notices (worktree fallbacks,
   * respawned agents). Ordinary narration — NOT errors.
   */
  logs: string[]
  /**
   * Steps the engine reported as failed, from the run's terminal outcome. A
   * non-empty list here means something actually went wrong.
   */
  failures: string[]
  startedAt: number
  endedAt?: number
  error?: string
  hasResult: boolean
}
