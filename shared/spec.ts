/**
 * OperonSpec — the spec workflow (v3), shared by the server (`/api/spec`, the
 * taskboard tools) and the desktop UI.
 *
 * A spec is a parent task plus a `spec_runs` row. The row says where the change
 * stands; everything the agents produced lives as files on the task's change
 * branch under `.operon/changes/task-<N>/` until sign-off. Final snapshots stay
 * in `spec_artifacts`; the execution files are removed before the change lands.
 */

export const SPEC_STAGES = [
  /** Explorers are mapping the code the change touches. */
  'grounding',
  /** Candidates, judge, lead synthesis and the builder check are running. */
  'designing',
  /** The builder check left questions only the user can answer. */
  'awaiting_answers',
  /** Design and tickets are written; waiting for gate 1. */
  'awaiting_design',
  /** Gate 1 signed: tickets are being built, reviewed and merged into the change branch. */
  'building',
  /** Every ticket is merged; reviewers from different families are checking the whole change. */
  'reviewing',
  /** review.md is written; waiting for gate 2. */
  'awaiting_signoff',
  /**
   * Signing gate 2 hit a conflict merging the default branch in: the spec's
   * coordinator is resolving it, and the result is reviewed before gate 2 again.
   */
  'integrating',
  /** Gate 2 signed: the change is merged into the default branch. */
  'done',
  /** A run stopped on request (or the app quit mid-run); resumable. */
  'stopped',
  /** A run failed; resumable once the cause is dealt with. */
  'failed',
] as const

export type SpecStage = (typeof SPEC_STAGES)[number]

export function isSpecStage(value: unknown): value is SpecStage {
  return typeof value === 'string' && (SPEC_STAGES as readonly string[]).includes(value)
}

/** Stages during which a design run is (or should be) executing. */
export const ACTIVE_SPEC_STAGES: readonly SpecStage[] = ['grounding', 'designing']

/** Stages after gate 1: the design is signed and the tickets exist. */
export const SIGNED_SPEC_STAGES: readonly SpecStage[] = ['building', 'reviewing', 'awaiting_signoff', 'integrating', 'done']

/** One agent seat: which provider runs it, and optionally which model. */
export interface SpecSeat {
  providerId: string
  /** Undefined = the provider's own default model. */
  modelId?: string
}

/** Who plays each role in a spec run. Fixed when the spec starts; editable at gate 1 for building. */
export interface SpecRunConfig {
  /** Synthesizes, triages, writes tickets. Defaults to the launching chat's provider. */
  lead: SpecSeat
  /** Read-only explorers for grounding. */
  explorer: SpecSeat
  /** Design candidates — at least two, from different families where possible. */
  candidates: SpecSeat[]
  /** Scores candidates against the lead's private rubric; a different family from the lead. */
  judge: SpecSeat
  /** Reads the design as the person who has to build it. */
  builder: SpecSeat
  /**
   * Builds tickets by default; gate 1 can pick another provider per ticket.
   * Absent on specs started before the build stage existed — read through
   * `withBuildDefaults`.
   */
  implementer?: SpecSeat
  /**
   * Reviews tickets and the whole change. Absent: picked per ticket from another
   * family than its implementer's (`reviewerFor`).
   */
  reviewer?: SpecSeat
  /** Coordinates the build. Absent: the lead's seat. */
  coordinator?: SpecSeat
  /** How many tickets may be in progress or in review at once. */
  concurrency?: number
}

/** The roles of a spec, each played by one seat (candidates by several). */
export const SPEC_ROLES = ['lead', 'explorer', 'candidate', 'judge', 'builder', 'implementer', 'reviewer', 'coordinator'] as const

export type SpecRole = (typeof SPEC_ROLES)[number]

export function isSpecRole(value: unknown): value is SpecRole {
  return typeof value === 'string' && (SPEC_ROLES as readonly string[]).includes(value)
}

/** Roles that run before gate 1 — the design stage. */
export const DESIGN_ROLES: readonly SpecRole[] = ['lead', 'explorer', 'candidate', 'judge', 'builder']

/**
 * Moving one role to another agent: the spec's seat for it, or — for an
 * implementer or reviewer with `ticketKey` — one ticket's.
 */
export interface SpecSwitch {
  role: SpecRole
  /** Which candidate, 0-based (role `candidate`). */
  index?: number
  /** One ticket's implementer or reviewer, instead of the spec's default for the role. */
  ticketKey?: string
  to: SpecSeat
}

/**
 * A switch the coordinator asks the user for — an agent out of quota, failing to
 * start, stuck. Nothing changes until the user says yes.
 */
export interface SpecSwitchProposal extends SpecSwitch {
  /** Who plays the role now. */
  from: SpecSeat | null
  reason: string
  proposedAt: number
}

/** One seat as the switch picker lists it. */
export interface SpecSeatView {
  role: SpecRole
  index?: number
  ticketKey?: string
  seat: SpecSeat
  /** Not set explicitly: chosen per ticket (a reviewer from another family), shown as the current pick. */
  auto?: boolean
}

/**
 * Settings → OperonSpec: who plays each role in a new spec. A role left out is
 * picked automatically (model diversity across families); agents the user names
 * in the chat still win for the candidates.
 */
export interface SpecRoleSettings {
  lead?: SpecSeat | null
  explorer?: SpecSeat | null
  /** Empty or absent: picked automatically. */
  candidates?: SpecSeat[]
  judge?: SpecSeat | null
  builder?: SpecSeat | null
  implementer?: SpecSeat | null
  reviewer?: SpecSeat | null
  coordinator?: SpecSeat | null
}

/** Where one ticket stands in the build. The board status follows; this says why. */
export type SpecTicketState =
  /** Waiting for a blocker to merge, or for a free slot. */
  | 'waiting'
  /** Its implementer is working (first pass, a rework round, or a merge conflict). */
  | 'building'
  /** A reviewer from another family is reading its diff. */
  | 'reviewing'
  /** Reviewed and merged into the change branch. */
  | 'merged'
  /** Three review rounds did not pass; needs a person. Tickets after it wait. */
  | 'blocked'

/** One ticket's build record — the orchestrator's state, kept on the spec row. */
export interface SpecTicketBuild {
  key: string
  taskId: number
  /** Provider building it. */
  implementer: string
  /** Model its implementer runs on; absent = the provider's default. */
  implementerModelId?: string
  /** Provider reviewing it — a different family from the implementer, unless the user picked otherwise. */
  reviewer: string
  /** Model its reviewer runs on; absent = whatever the spec uses that provider with. */
  reviewerModelId?: string
  /** Review rounds that asked for changes. */
  rounds: number
  state: SpecTicketState
  /** Head of the ticket branch at the last review; the next review reads only what came after. */
  reviewedSha?: string
  /** The issues the last review raised, handed to the next one to check. */
  openIssues?: string[]
  /** Why it is blocked, in a sentence. */
  blockedReason?: string
  /** Its implementer already got the one reminder for a turn that ended without handing the ticket in. */
  nudged?: boolean
  /**
   * Blocked, and handed to the spec's coordinator (`asked`), or passed on by it
   * to the user (`escalated`). Cleared when the ticket moves again.
   */
  coordinator?: 'asked' | 'escalated'
  /**
   * The agent it was taken from when it was switched to another (`codex · gpt-5`),
   * until the new one starts: that session is told the worktree holds the
   * previous agent's work.
   */
  handedOver?: string
  /** Times the coordinator set it going again; past the limit a block goes straight to the user. */
  retries?: number
  /**
   * Every chat its implementer worked in, oldest first. Kept here because the
   * ticket's workspace goes away when it lands, and with it the only other
   * route to these conversations.
   */
  chatIds?: number[]
}

/** How far a spec's build has got, as its board card shows it. */
export interface SpecProgress {
  merged: number
  total: number
  blocked: number
}

/** A small call an implementer made where the design was unclear, recorded for gate 2. */
export interface SpecRuling {
  ticketKey: string
  ruling: string
}

export interface SpecRun {
  taskId: number
  stage: SpecStage
  config: SpecRunConfig
  designSha: string | null
  /** The latest workflow run — the one a resume or stop acts on. */
  workflowRunId: string | null
  /** Every workflow run this spec has had, oldest first: each start, resume and redesign is one. */
  runIds: string[]
  /** One entry per ticket from gate 1 on; empty before. */
  build: SpecTicketBuild[]
  rulings: SpecRuling[]
  error: string | null
  /** A switch the coordinator asked the user for, until they take it or turn it down. */
  proposal: SpecSwitchProposal | null
  createdAt: number
  updatedAt: number
}

export interface CreateSpecRunInput {
  taskId: number
  stage: SpecStage
  config: SpecRunConfig
}

export interface UpdateSpecRunInput {
  stage?: SpecStage
  config?: SpecRunConfig
  designSha?: string | null
  workflowRunId?: string | null
  build?: SpecTicketBuild[]
  rulings?: SpecRuling[]
  error?: string | null
  proposal?: SpecSwitchProposal | null
}

/** One vertical slice, as the lead produces it (structured output, never parsed from markdown). */
export interface SpecTicket {
  /** 'T1', 'T2', … — unique within the spec. */
  key: string
  title: string
  /** The end-to-end behaviour it makes work, from the user's point of view. */
  delivers: string
  /** Checkable acceptance criteria. */
  acceptance: string[]
  /** Keys of tickets that must finish first. */
  blockedBy: string[]
  /** Interfaces from design.md this ticket provides or depends on. */
  interfaces: string[]
}

/** A question from the builder check that only the user can answer. */
export interface SpecQuestion {
  question: string
  /** Why the answer changes what gets built; empty when the question says it all. */
  why: string
}

/** A call the lead made on the user's behalf after the builder check. */
export interface SpecCall {
  question: string
  decision: string
}

/** One design candidate as the UI shows it. */
export interface SpecCandidateView {
  key: string
  providerId: string
  content: string
}

/** Everything the spec card and the task page need, in one read. */
export interface SpecView {
  taskId: number
  taskNumber: number
  title: string
  run: SpecRun
  /** Absolute path of the change worktree, for "open in editor". */
  worktreePath: string | null
  /** The change branch — still named once its worktree is removed, as a finished spec's is. */
  branchName: string | null
  /** Path of the spec directory inside the worktree. */
  specDir: string
  brief: string | null
  grounding: string | null
  candidates: SpecCandidateView[]
  judge: string | null
  design: string | null
  synthesis: string | null
  tickets: SpecTicket[] | null
  /** Questions waiting for the user (stage awaiting_answers). */
  questions: SpecQuestion[] | null
  feedback: string | null
  /** review.md — the whole-change review gate 2 signs (stage awaiting_signoff and after). */
  review: string | null
  /** The same review, structured, for counts and the evidence table. */
  reviewSummary: SpecReviewSummary | null
  /** True while a design run or a ticket review for this spec is executing in this process. */
  running: boolean
  /** Providers this spec works with — the ones a ticket can be given to at gate 1. */
  providers: string[]
  /** Every provider usable here — what a role can be switched to. */
  availableProviders: string[]
  /** Who plays each role now, for switching one. */
  seats: SpecSeatView[]
  /** Approved, but design.md no longer matches what was signed — dispatch waits for a re-approval. */
  designChanged: boolean
  /** The subtask each ticket became, by ticket key (empty until approval). */
  ticketTasks: Record<string, SpecTicketTask>
  /** Every agent the spec has run, across all its runs, in the order they started. */
  agents: SpecAgentRun[]
  /** The conversation the spec was started from. */
  sourceChat: SpecChatRef | null
  /** Time agents have spent working on the spec so far, in ms — parallel ones counted once, waits for the user not at all. */
  elapsedMs: number
  /** The agent that coordinates the build, once gate 1 has given it one. */
  coordinator: SpecCoordinatorView | null
  /** A sign-off conflict the coordinator is resolving (stage integrating). */
  integration: SpecIntegration | null
}

/**
 * The spec's coordinator: one long-lived session on the change branch that takes
 * what needs judgement — a blocked ticket, a sign-off conflict, what the user
 * says on the spec — while the build itself runs on rules.
 */
export interface SpecCoordinatorView {
  agentName: string
  providerId: string
  modelId?: string
  /** Its session: active while a turn runs, idle between, offline before the first. */
  status: 'active' | 'idle' | 'offline' | null
  /** Its conversation, once it has had one. */
  chatId: number | null
  /** The same, as a link the spec's Sessions tab opens — its working log. */
  chat?: SpecChatRef | null
  /** The change worktree its session runs in. */
  workspaceId: number | null
}

/** integration.json: why the spec is integrating. Removed once the result is reviewed. */
export interface SpecIntegration {
  /** The default branch that would not merge in. */
  target: string
  /** Files git could not merge. */
  files: string[]
  startedAt: number
  /** What the coordinator says it did, once it hands the result in. */
  summary?: string
}

/** What the gate 2 header says about the review at a glance. */
export interface SpecReviewSummary {
  actOn: number
  consider: number
  noted: number
  dismissed: number
  pass: number
  fail: number
  notRun: number
  summary: string
}

/** One agent call of a spec run, as the progress card lists it. */
export interface SpecAgentRun {
  /** The workflow run it belongs to; with `index`, addresses its recorded output. */
  runId: string
  index: number
  /** e.g. 'candidate A · codex'. */
  label: string
  phase?: string
  /** The provider that ran it. */
  agentType?: string
  modelId?: string
  state: 'queued' | 'running' | 'done' | 'error'
  resultPreview?: string
  error?: string
  startedAt?: number
  endedAt?: number
  /** The conversation it ran as, newest last (a handoff starts a new one); absent for agents from before agents ran as chats. */
  chats?: SpecChatRef[]
}

/** The board task a ticket became at approval. */
export interface SpecTicketTask {
  id: number
  number: number
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'
  /** The worktree its session runs in, once dispatched — where a person takes over a stuck ticket. */
  workspaceId: number | null
  /** The chats its implementer worked in, oldest first — still there after the ticket lands. */
  chats: SpecChatRef[]
}

/** A conversation that belongs to a spec, as its panel links to it. */
export interface SpecChatRef {
  chatId: number
  /** Original execution directory; it may have been removed after the run. */
  cwd?: string | null
  title: string
  providerId: string | null
  /** Where it opens: its own workspace, or the spec's once that one is gone (a landed ticket's). */
  workspaceId: number | null
  /** An agent's conversation, which keeps the model it was started with. */
  subAgent: boolean
  updatedAt: number
}
