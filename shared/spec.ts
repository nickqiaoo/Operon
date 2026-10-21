/**
 * OperonSpec — the spec workflow (v3), shared by the server (`/api/spec`, the
 * taskboard tools) and the desktop UI.
 *
 * A spec is a parent task plus a `spec_runs` row. The row says where the change
 * stands; everything the agents produced lives as files on the task's change
 * branch under `.operon/changes/task-<N>/`.
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
export const SIGNED_SPEC_STAGES: readonly SpecStage[] = ['building', 'reviewing', 'awaiting_signoff', 'done']

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
  /** How many tickets may be in progress or in review at once. */
  concurrency?: number
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
  /** Provider reviewing it — always a different family from the implementer. */
  reviewer: string
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
  /** The ADRs and glossary terms this change records at gate 2 (drafted when the review ends). */
  decisions: SpecDecisions | null
  /** True while a design run or a ticket review for this spec is executing in this process. */
  running: boolean
  /** Providers this spec works with — the ones a ticket can be given to at gate 1. */
  providers: string[]
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
}

/**
 * What a spec leaves behind for later work: architecture decision records under
 * `docs/adr/` and terms in `GLOSSARY.md`. The lead drafts them when the review
 * ends (`decisions.json` in the spec directory); signing gate 2 writes them into
 * the repository on the change branch, numbered after the ADRs the default
 * branch already has, so they merge in with the change.
 */
export interface SpecDecisions {
  adrs: SpecAdr[]
  glossary: SpecGlossaryTerm[]
  /** Set once gate 2 wrote them: the repository paths that were written. */
  recorded: { at: number; files: string[] } | null
}

/** One architecture decision record. Never edited once written; a changed decision gets a new one that supersedes it. */
export interface SpecAdr {
  /** Short kebab-case file name part, e.g. 'reminders-own-table'. */
  slug: string
  title: string
  context: string
  decision: string
  /** What follows from it, including the alternatives turned down and why. */
  consequences: string
  /** Number of an earlier ADR this one replaces, if any. */
  supersedes: number | null
  /** Assigned when written at gate 2. */
  number: number | null
}

export interface SpecGlossaryTerm {
  term: string
  definition: string
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
  title: string
  providerId: string | null
  /** Where it opens: its own workspace, or the spec's once that one is gone (a landed ticket's). */
  workspaceId: number | null
  /** An agent's conversation, which keeps the model it was started with. */
  subAgent: boolean
  updatedAt: number
}
