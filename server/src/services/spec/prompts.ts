/**
 * OperonSpec prompts — every role in a spec run, plus the chat's standing hint.
 *
 * Adapted, not copied, from pstack (`how`, `architect`, `arena`), superpowers
 * (`brainstorming` builder check, `writing-plans`) and mattpocock/skills
 * (`grilling`, `to-tickets`, `codebase-design`). Their CLI and file mechanics are
 * stripped; what is kept is the reasoning discipline. Sources are cloned under
 * /Volumes/data/project/specdev for reference. TS constants on purpose: no file
 * IO at runtime, edit and rebuild to change them.
 */

import type { SpecCall, SpecQuestion, SpecTicket } from '../../types/spec.js'

/** Every role writes prose in the user's language; ids, paths and code stay as they are. */
const LANGUAGE_RULE =
  'Write all prose in the same language as the brief (if the brief is in Chinese, write in Chinese). ' +
  'Keep identifiers, file paths, code and the section headings given below exactly as written.'

const READ_ONLY_RULE =
  'You are working in a disposable copy of the repository. Read anything you need; do not try to change the real ' +
  'project — anything you write on disk is thrown away. Your final reply is your deliverable: the server saves it.'

/**
 * The user's answers given after the brief, placed right under it. Every role
 * that reads the brief must also read these: the brief's Open section still
 * says those questions are open, and a role that sees only the brief re-opens
 * them.
 */
function decisionsSince(answers: string | null): string {
  if (!answers) return ''
  return `\n## Decisions the user made since the brief\nThese override anything in the brief they contradict, including questions the brief lists as open.\n\n${answers}\n`
}

// ---------------------------------------------------------------------------
// The chat side
// ---------------------------------------------------------------------------

/**
 * Standing hint for a direct workspace chat. Kept short: it carries only the
 * sizing rule and when to start; the full alignment discipline lives in the
 * `operon-spec` skill, and the brief format in the `start_spec` tool itself.
 */
export const SPEC_CHAT_HINT = `## Project Taskboard and OperonSpec
Project tasks are durable, shared Taskboard records. Built-in task or todo tools belong only to the agent runtime's private execution plan; never use them to create, read, update, or track project tasks.

Size every request before you act, and say the size in one plain line (the user can override it):
- **quick** — everything that matters is in the request: just do it.
- **small** — one or two places, obvious approach: agree it in chat, then do it.
- **project** — crosses modules, moves ownership, or has more than one reasonable shape: run it as an OperonSpec. Load the \`operon-spec\` skill and follow it: align with the user first, then call \`start_spec\`. Several agents from different families then design it in parallel and the user signs the design once.

If the user says "just do it", skip the spec. If they invoke /operon-spec, run it as a spec whatever the size.`

/** The `start_spec` tool's description — also where the brief format is defined. */
export const START_SPEC_DESCRIPTION = [
  'OperonSpec: turn the request you have aligned with the user into a spec. Several agents from different model families',
  'explore the code, design it in parallel, and are judged and synthesized into one design the user signs. Call ONLY after',
  'the alignment conversation is done and the user agreed to start (see the operon-spec skill). It returns at once; the',
  'design runs in the background and its result comes back to this chat — do not poll.',
  '',
  'The brief is the only thing the designers will know about the conversation, so it must carry all of it. Markdown with',
  'exactly these sections, in the user\'s language:',
  '## Intent — why this is wanted, who it is for, one concrete moment it matters',
  '## Goals / Non-goals / Anti-goals',
  '## Decided — what the user decided, including any "how it gets made" choices they own (platform, library, storage…)',
  '## Delegated — what the user left to the agents',
  '## Constraints',
  '## Open — questions deliberately left for the design',
].join('\n')

/** What the chat agent is told when the design stage ends, folded into the run result. */
export function designReadyNext(taskNumber: number): string {
  return (
    `The design for spec task #${taskNumber} is ready and waiting for the user's sign-off. Summarize it for the user in a few ` +
    'lines (the chosen shape, which candidate it was based on, anything the agents decided on their behalf), then ask them ' +
    'to review it and approve it on the spec card or the task page, or request changes there with a comment (the buttons ' +
    "are labelled in the user's UI language, so describe them rather than quoting English labels). " +
    'Do not approve it yourself and do not start implementing.'
  )
}

/**
 * What the chat agent is told when the change is built, reviewed and waiting for
 * gate 2. `crossFamily` is false when some ticket was reviewed by its own
 * implementer's family (a spec limited to one agent) — the agent would otherwise
 * tell the user something that did not happen.
 */
export function signoffNext(taskNumber: number, crossFamily: boolean): string {
  const reviewed = crossFamily ? 'reviewed by another model family' : 'reviewed in a separate session'
  return (
    `Spec task #${taskNumber} is built: every ticket was ${reviewed} and merged, and the whole change ` +
    'was reviewed again. Summarize the review for the user in a few lines — whether it is ready, anything still to act on or ' +
    'worth considering, and which acceptance criteria were not verified (NOT_RUN) — then ask them to sign it off on the spec ' +
    'card or the task page, which merges it into the default branch together with the ADRs and glossary terms it records ' +
    "(listed under Decisions on the task page), or to request changes there (the buttons are labelled in the user's " +
    'UI language, so describe them rather than quoting English labels). Do not sign it off yourself.'
  )
}

export function answersNeededNext(taskNumber: number): string {
  return (
    `The design for spec task #${taskNumber} needs the user's answers before it can be finished. Ask the user these ` +
    'questions in ONE message, most important first, each with your recommended answer. When they reply, call ' +
    `answer_spec_questions(task: ${taskNumber}, answers: "<their answers, numbered to match>"). Do not answer for them.`
  )
}

// ---------------------------------------------------------------------------
// ③ Ground
// ---------------------------------------------------------------------------

export interface GroundingAngle {
  title: string
  focus: string
}

/** Fixed angles: deterministic, and they cover what every design needs to know. */
export const GROUNDING_ANGLES: GroundingAngle[] = [
  {
    title: 'Data and state',
    focus:
      'The data model the change touches: types, database tables and migrations, stores, who owns each piece of state and who writes it.',
  },
  {
    title: 'Flow and surfaces',
    focus:
      'The runtime path: entry points, routes or commands, services and the UI components involved, step by step with the data passed between them.',
  },
  {
    title: 'Conventions and history',
    focus:
      'The rules this code lives under: project instruction files (CLAUDE.md, AGENTS.md), docs/adr and GLOSSARY.md if present, similar features to copy, test setup and the commands to run them, and recent git history of the area (why it looks the way it does).',
  },
]

export function explorerPrompt(brief: string, angle: GroundingAngle): string {
  return `You are one of several explorers mapping a codebase before a change is designed. Others cover other angles in parallel — do not try to cover everything. Go deep on yours. Map the code as it is today; designing the change is someone else's job, so do not propose designs or weigh options for it.

${READ_ONLY_RULE}

## The change being considered
${brief}

## Your angle: ${angle.title}
${angle.focus}

## Output
### Components found
Key types, services, modules. For each: name, file path, one sentence on what it does.
### Flow
Step by step: what runs, in which file, what it calls next, what data moves.
### Boundaries
Where this connects to the rest of the codebase; inputs and outputs.
### Non-obvious things
Anything surprising, historically motivated, or easy to get wrong.
### Open questions
What you could not trace. Be honest about gaps.

Give file pointers, not pasted code. ${LANGUAGE_RULE}`
}

export function explainerPrompt(brief: string, findings: { angle: string; text: string }[]): string {
  return `Several explorers traced different slices of a codebase in parallel, ahead of designing a change. Merge their findings into one grounding document that the designers will read instead of exploring from scratch.

${READ_ONLY_RULE} Check the code yourself where explorers disagree or left a gap.

## The change being considered
${brief}

## Explorer findings
${findings.map((f) => `### ${f.angle}\n${f.text}`).join('\n\n')}

## Output
A markdown document with these sections (drop one only if it has nothing to say):
## Overview
## Key concepts
## How it works
## Where things live
## Conventions to follow
(project rules, existing ADRs/glossary terms, the pattern to copy, the test command)
## Gotchas

Concrete language, file pointers, no large code blocks. Acknowledge open gaps instead of hiding them. Describe only how the code works today: no proposed designs, candidate options or decisions about the change — those are made later, and whatever you write here every later step reads as fact. ${LANGUAGE_RULE}`
}

// ---------------------------------------------------------------------------
// ④ Design: rubric → candidates → judge → synthesis
// ---------------------------------------------------------------------------

export const RUBRIC_SCHEMA = {
  type: 'object',
  properties: {
    criteria: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
  },
  required: ['criteria'],
} as const

export function rubricPrompt(brief: string, grounding: string): string {
  return `You will judge competing designs for the change below. Before seeing any of them, write the rubric: 3-6 concrete, gradeable criteria for what success looks like on THIS change (not generic virtues). The candidates never see it.

Good criteria name an observable property: "a new channel kind is added by registering one adapter, not by editing the router", "no state is written by more than one module", "the user-facing behaviour in Goals is reachable with no new settings". Weak criteria are adjectives: "clean", "scalable".

## Brief
${brief}

## Grounding
${grounding}`
}

/** Directions handed to candidates so they spread across the design space instead of converging. */
export const CANDIDATE_DIRECTIONS = [
  'Minimize the interface: as few entry points as possible, maximum capability behind each.',
  'Optimize for the most common caller: make the default case trivial, even if rarer cases cost more.',
  'Maximize flexibility: design for the variations the brief hints at, without building them yet.',
  'Design around the existing seams in the codebase: change as little structure as possible.',
  'Rethink from first principles: assume the current structure is negotiable if a cleaner shape exists.',
]

export function candidatePrompt(brief: string, grounding: string, direction: string, recorded = ''): string {
  return `You are producing ONE candidate design for the change below. Other candidates, each on a different model, are designing the same change in parallel. The differences between candidates are the signal used to pick and combine — do not hedge toward a safe middle. Produce the best design your model can make.

${READ_ONLY_RULE} You may sketch code in the disposable copy to test an idea, but put everything that matters in your reply.

## Brief
${brief}

## Grounding (how the code works today)
${grounding}
${recordedSection(recorded)}
## Your leaning
${direction}
Follow it unless the brief rules it out — then say so and why.

## Discipline
- **Caller's usage first.** Before any types, write how callers use it: a short README-style explanation and two or three real call sites. Derive the types from the usage, never the reverse.
- **Data structures first.** Get the core types right; trace each main access pattern through them. "We'll add a cache later" means the structure is wrong.
- **Deep interfaces.** A small surface hiding a lot of behaviour beats a wide surface that leaks how it works. Keep transport/storage types off the public surface.
- **One owner per piece of state.** If two places could write it, say who owns it.
- **One way to do each thing.** The next contributor is an agent that copies the nearest example; make the right example the only one.
- Respect the project's conventions in the grounding and the decisions already recorded.
- Show bodies as \`not implemented\` with doc comments for intent and invariants; pseudocode only for genuinely tricky logic.

## Output — markdown, these sections
## Problem
## Usage
(the caller's view — written first)
## Shape
(data structures, signatures, module map; what each module owns; what the public surface hides)
## Tradeoffs accepted
("we accept X in exchange for Y")
## Alternatives rejected
(at least one whole-shape alternative and why it lost)
## Open questions and risks

${LANGUAGE_RULE}`
}

export function judgePrompt(brief: string, criteria: string[], candidates: { key: string; text: string }[]): string {
  return `You are a read-only judge. Score competing designs for one change against a fixed rubric, criterion by criterion — not on overall feel — and recommend which one should be the base for the final design.

## Brief
${brief}

## Rubric
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Candidates
${candidates.map((c) => `### Candidate ${c.key}\n${c.text}`).join('\n\n')}

## Output — markdown
## Scores
A table: one row per criterion, one column per candidate, scores 1-5, each with a one-line reason.
## Red flags
Per candidate: shallow modules, leaked internals, state written in two places, two ways to do one thing, steps that only make sense in execution order. Only real ones.
## Recommendation
The base candidate and why; the one or two ideas worth grafting from each other candidate; whether the candidates broadly agree (strong signal) or diverge wildly (the brief may be underspecified — say what it fails to pin down).

${LANGUAGE_RULE}`
}

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['converged', 'synthesized', 'diverged'] },
    base: { type: 'string', description: 'Key of the candidate used as the base (A, B, …)' },
    design: { type: 'string', description: 'The full design document, markdown' },
    synthesis: { type: 'string', description: 'The synthesis note, markdown' },
    underspecified: {
      type: 'array',
      items: { type: 'string' },
      description: 'When verdict is "diverged": what the brief fails to pin down, phrased as questions for the user',
    },
  },
  required: ['verdict', 'base', 'design', 'synthesis'],
} as const

export interface SynthesisResult {
  verdict: 'converged' | 'synthesized' | 'diverged'
  base: string
  design: string
  synthesis: string
  underspecified?: string[]
}

export function synthesisPrompt(input: {
  brief: string
  grounding: string
  criteria: string[]
  candidates: { key: string; provider: string; text: string }[]
  judge: string
  feedback: string | null
  answers: string | null
  recorded?: string
}): string {
  return `You are the lead designer. Several candidates designed the same change in parallel and a judge on another model scored them against your rubric. Produce the ONE design the user will sign.

## How to synthesize
1. Read every candidate end to end. Score each against the rubric yourself, then compare with the judge. Agreement confirms the base; disagreement means read both rationales again before deciding.
2. Pick the base a future maintainer can extend most easily without breaking its invariants. When tied, prefer the smaller public surface.
3. Walk each other candidate once more for what is worth porting — usually one or two ideas each, not most of it — and fold each in by hand so the result stays one coherent design. Never paste sections side by side.
4. If the candidates converge on one shape, say so (verdict "converged"): that agreement is evidence. Being equally sound is not converging — they converge when they would build the same thing.
   If they give different answers to a question that changes what the user experiences or what gets built, and the brief does not settle it, the brief is underspecified: do NOT average them, and do NOT write a design that offers the options for the user to pick from later. Set verdict "diverged" and list in \`underspecified\` the choice the user must make. Any design that would have to say "the user chooses A or B" is a diverged one.
   Otherwise verdict "synthesized".
${input.answers ? '5. The user has since answered questions the brief left open (see "Decisions the user made since the brief"). They are part of the brief and they settle those questions: build the design on them, and never leave an answered choice open again.' : ''}
${input.feedback ? `${input.answers ? 6 : 5}. The user asked for changes to an earlier version of this design (see "User feedback"). Address every point.` : ''}

## Brief
${input.brief}
${decisionsSince(input.answers)}
## Grounding
${input.grounding}
${recordedSection(input.recorded ?? '')}
## Your rubric
${input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Candidates
${input.candidates.map((c) => `### Candidate ${c.key} (${c.provider})\n${c.text}`).join('\n\n')}

## Judge
${input.judge}
${input.feedback ? `\n## User feedback on the previous design\n${input.feedback}\n` : ''}
## The design document (\`design\`)
Written for a capable engineer who will plan and build from it without talking to anyone. Sections:
## Intent
## Usage
(caller's view first)
## Shape
(data structures, interfaces and signatures, module map, who owns what state)
## Behaviour
(what the user can observe, including errors and edge cases the brief implies)
## Constraints and conventions
## Left to the builder
(what the design deliberately does not decide)
No file-by-file task list and no full code — interfaces and decisions only.

## The synthesis note (\`synthesis\`)
## Base
(which candidate and why; the judge's verdict and whether you agreed)
## Grafted
(each idea taken from another candidate, with its source)
## Rejected
(what was turned down and why)

${LANGUAGE_RULE}`
}

// ---------------------------------------------------------------------------
// ④-5 Builder check
// ---------------------------------------------------------------------------

const NOTHING_LEFT = 'nothing important left'

/**
 * Whether the builder found nothing worth asking. Matched at the end of the
 * reply, not as the whole reply: agents often say what they are about to check
 * before giving the verdict.
 */
export function builderFoundNothing(reply: string): boolean {
  return new RegExp(`${NOTHING_LEFT}["'”」]?\\s*[.。]?\\s*$`, 'i').test(reply.trim())
}

export function builderCheckPrompt(design: string): string {
  return `You are a talented software engineer. You have been handed the design document below and asked to plan how to build it. You will not be able to talk to the person who wrote it.

${READ_ONLY_RULE} Look at the code wherever it helps you judge what is really missing.

Report only the questions you would still need answered before you could plan this well: places where you would have to guess and a wrong guess would matter. For each, give the question and why the answer changes the plan. Rank them by importance.

Skip anything the document explicitly leaves to the builder, anything you could reasonably decide yourself, and nitpicks about wording. If nothing important is left, reply exactly "${NOTHING_LEFT}".

## Design
${design}

${LANGUAGE_RULE}`
}

export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    design: { type: 'string', description: 'The full design document, revised' },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, decision: { type: 'string' } },
        required: ['question', 'decision'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, why: { type: 'string' } },
        required: ['question', 'why'],
      },
    },
  },
  required: ['design', 'calls', 'questions'],
} as const

export interface TriageResult {
  design: string
  calls: SpecCall[]
  questions: SpecQuestion[]
}

export function triagePrompt(brief: string, answers: string | null, design: string, builderQuestions: string): string {
  return `You are the lead designer. A fresh engineer read your design as the person who must build it and listed what they would still need to ask. Sort every question into exactly one pile:

- **Answered already** by the brief, the design or the code: put the answer into the design.
- **Minor**: a sensible builder could settle it without changing what gets built. Decide it yourself, put the decision into the design, and record it in \`calls\` so the user can check it.
- **Theirs**: only the user can answer it AND the answer changes what gets built. Put it in \`questions\` with why it matters. Be strict — every question here costs the user a round trip. A choice the user already made (see "Decisions the user made since the brief") is answered: never ask it again or reopen it in the design.

Return the full revised design (not a diff).

## Brief
${brief}
${decisionsSince(answers)}
## Design
${design}

## The builder's questions
${builderQuestions}

${LANGUAGE_RULE}`
}

export const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    design: { type: 'string', description: 'The full design document, revised' },
    calls: TRIAGE_SCHEMA.properties.calls,
  },
  required: ['design', 'calls'],
} as const

export function revisePrompt(brief: string, design: string, questions: SpecQuestion[], answers: string): string {
  return `You are the lead designer. You asked the user these questions about your design, and they answered. Fold every answer into the design and return the full revised design. If an answer leaves a gap you can settle sensibly, decide it and record it in \`calls\`.

## Brief
${brief}

## Design
${design}

## Your questions
${questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}

## The user's answers
${answers}

${LANGUAGE_RULE}`
}

// ---------------------------------------------------------------------------
// ④-6 Tickets
// ---------------------------------------------------------------------------

export const TICKETS_SCHEMA = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: "'T1', 'T2', …" },
          title: { type: 'string' },
          delivers: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
          blockedBy: { type: 'array', items: { type: 'string' } },
          interfaces: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'title', 'delivers', 'acceptance', 'blockedBy', 'interfaces'],
      },
    },
  },
  required: ['tickets'],
} as const

export function ticketsPrompt(design: string, grounding: string): string {
  return `Break the design below into tickets an agent can each pick up in a fresh session: tracer-bullet vertical slices, each declaring the tickets that block it.

## Rules
- **Vertical, not horizontal.** Each ticket cuts a narrow but COMPLETE path through every layer it needs (storage → service → interface → UI → tests). A finished ticket is demoable or verifiable on its own. Never "all the database work" as one ticket and "all the UI" as another.
- **One ticket fits one fresh context window.**
- **Prefactor first.** If a small restructuring makes the rest easy, make it the first ticket: make the change easy, then make the easy change.
- **Dependencies only through \`blockedBy\`.** A ticket lists the keys that must finish before it can start; one with none can start at once. Only real gates — a dependency that is merely "nice to have first" is not one.
- **Wide mechanical changes** (rename a column, retype a shared symbol) are the exception: expand (add the new form beside the old) → migrate callers in batches, each its own ticket blocked by the expand → contract (delete the old form) blocked by every batch.
- **No file paths and no code.** They go stale. Name the design's interfaces each ticket provides or depends on in \`interfaces\`.
- \`delivers\` is the end-to-end behaviour from the user's point of view; \`acceptance\` are checkable criteria, one per item.
- Keys are T1, T2, … in dependency order (blockers first).
- **The design is the only source of what to build.** The grounding only tells you how the code works today: never take scope, options or open questions from it. Every choice is already made by the time you run, so no ticket asks anyone to decide anything.

## Design
${design}

## Grounding
${grounding}

${LANGUAGE_RULE}`
}

/** The description a ticket's subtask carries: what to build, how to know it is done, where the design is. */
export function ticketDescription(ticket: SpecTicket, specTaskNumber: number, designPath: string): string {
  const lines = [ticket.delivers, '', '## Acceptance', ...ticket.acceptance.map((a) => `- [ ] ${a}`)]
  if (ticket.interfaces.length > 0) {
    lines.push('', '## Interfaces', ...ticket.interfaces.map((i) => `- ${i}`))
  }
  lines.push('', `Part of spec #${specTaskNumber} — read the design first: \`${designPath}\` on its change branch.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// ⑤ Build: ticket review
// ---------------------------------------------------------------------------

export const TICKET_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          where: { type: 'string', description: 'file:line, or the requirement it concerns' },
          issue: { type: 'string', description: 'What is wrong, why it matters, how to fix it if not obvious' },
        },
        required: ['severity', 'where', 'issue'],
      },
    },
    rulings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every "Ruling: …" the implementer recorded in its report, verbatim',
    },
    designBroken: {
      type: 'string',
      description:
        'Empty, unless the design itself cannot be built as written (not this implementation — the design): then what breaks and the evidence',
    },
  },
  required: ['verdict', 'issues', 'rulings', 'designBroken'],
} as const

export interface TicketReviewIssue {
  severity: 'critical' | 'important' | 'minor'
  where: string
  issue: string
}

export interface TicketReviewResult {
  verdict: 'pass' | 'changes'
  issues: TicketReviewIssue[]
  rulings: string[]
  designBroken: string
}

/** Above this the diff is summarized by its stat and the reviewer reads the changed files itself. */
const MAX_DIFF_CHARS = 150_000

function diffSection(diff: string, stat: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return `\`\`\`diff\n${diff}\n\`\`\``
  return `The diff is too large to include. Files changed:\n\`\`\`\n${stat}\n\`\`\`\nRead the changed files in your checkout (it is at the ticket's head).`
}

export interface TicketReviewInput {
  design: string
  ticket: SpecTicket
  /** The implementer's own account of what it did, if it left one. */
  report: string | null
  diff: string
  stat: string
  /** Issues from the previous round, when this is a re-review. */
  openIssues?: string[]
  /** The implementer is from another model family than the reviewer (false in a one-agent spec). */
  crossFamily: boolean
}

export function ticketReviewPrompt(input: TicketReviewInput): string {
  const ticket = [
    `### ${input.ticket.key}. ${input.ticket.title}`,
    input.ticket.delivers,
    '',
    'Acceptance:',
    ...input.ticket.acceptance.map((a) => `- ${a}`),
    ...(input.ticket.interfaces.length > 0 ? ['', 'Interfaces:', ...input.ticket.interfaces.map((i) => `- ${i}`)] : []),
  ].join('\n')
  const rereview = input.openIssues != null && input.openIssues.length > 0
  const scope = rereview
    ? `## This is a re-review
A previous review raised the findings below and the implementer has tried to fix them. The diff is only the fix. Verdict every finding — "attempted" is not addressed: the defect must no longer exist — and check the fix diff for anything it broke. Do NOT re-review code the fix did not touch; a whole-branch review happens after every ticket is merged.

### Findings under verification
${input.openIssues!.map((i) => `- ${i}`).join('\n')}`
    : `## Scope
This is a ticket-scoped gate, not a merge review: a whole-branch review happens after every ticket is merged. Inspect code outside the diff only to check a concrete risk you can name (a changed contract, shared state, lock ordering) — one focused check per risk.`

  return `You are reviewing one ticket of a larger change: first whether it does what the ticket asks — nothing more, nothing less — then whether it is well built. ${input.crossFamily ? 'Another agent, from another model family, implemented it.' : 'Another session implemented it; you have not seen its reasoning, so judge the diff on its own.'}

${READ_ONLY_RULE} Do not change the checkout. Do not dispatch sub-agents; do the whole review yourself.

${scope}

## Do not trust the report
The implementer's report is a set of claims. Verify them against the diff. A stated rationale ("kept it simple on purpose") is the implementer grading its own work and never lowers a finding's severity. The implementer ran the tests; do not re-run the suite to confirm the report.

## What to check
- **Missing**: acceptance criteria skipped or claimed without being implemented.
- **Extra**: work the ticket did not ask for, or work another ticket owns.
- **Misunderstood**: the right thing built the wrong way; an interface that does not match the design.
- **Quality**: error handling, edge cases, tests that verify real behaviour, one clear job per file. For behaviour the design does not mention, judge by what a reasonable user would expect.

## Severity
- **critical / important**: the ticket cannot be trusted until it is fixed — wrong or fragile behaviour, a missed acceptance criterion, a swallowed error, a test that asserts nothing. Any of these means verdict "changes".
- **minor**: polish and suggestions. They never block: with only minor issues the verdict is "pass".

If the design itself cannot be built as written — not this implementation, the design — say what breaks in \`designBroken\` with the evidence. Leave it empty otherwise; it pauses the whole change.

## The design
${input.design}

## The ticket
${ticket}

## The implementer's report
${input.report?.trim() || '(none — it left no report)'}

## ${rereview ? 'The fix diff' : 'The diff'}
${diffSection(input.diff, input.stat)}

Write \`issues\` so the implementer can act on each one without seeing anything else. ${LANGUAGE_RULE.replace('the brief', 'the design')}`
}

/** What the implementer is told when its ticket comes back from review. */
export function reworkMessage(taskNumber: number, round: number, issues: TicketReviewIssue[]): string {
  return [
    `Review round ${round} of ticket #${taskNumber} asked for changes. Fix every point below, re-run the checks that cover what you change, ` +
      'commit, then report what you changed (one line per point) and call ' +
      `update_project_task(task: ${taskNumber}, status: "in_review"). If you disagree with a point, say why in the report instead of ignoring it.`,
    '',
    ...issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.where} — ${i.issue}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// ⑥ Review: the whole change
// ---------------------------------------------------------------------------

export interface BranchReviewInput {
  brief: string
  design: string
  tickets: SpecTicket[]
  rulings: { ticketKey: string; ruling: string }[]
  diff: string
  stat: string
  /** The branch the change merges into, for running `git diff` yourself. */
  base: string
  /** Another reviewer, from another model family, reviews the change at the same time. */
  peerReviewer: boolean
}

function ticketChecklist(tickets: SpecTicket[]): string {
  return tickets
    .map((t) => [`### ${t.key}. ${t.title}`, ...t.acceptance.map((a, i) => `- ${t.key}.${i + 1} ${a}`)].join('\n'))
    .join('\n\n')
}

export function branchReviewPrompt(input: BranchReviewInput): string {
  return `You are an adversarial reviewer of a finished change: every ticket of it has been built, reviewed on its own and merged into this branch. Find the real problems in the change as a whole — bugs, design flaws, security issues, maintainability damage — and check every acceptance criterion with evidence. You are not here to be encouraging.${input.peerReviewer ? ' Another reviewer from another model family is doing the same independently.' : ''}

Your checkout is a disposable copy of the change branch: run whatever you need (tests, the build, a script) — nothing you change survives. Do not commit, push or open anything outside it. Do not dispatch sub-agents.

## Intent
Judge whether the code achieves this well. Do not question the intent itself.

${input.brief}

## The design it was built from
${input.design}

## Acceptance criteria
${ticketChecklist(input.tickets)}

## Calls the implementers made where the design was unclear
${input.rulings.length > 0 ? input.rulings.map((r) => `- ${r.ticketKey}: ${r.ruling}`).join('\n') : '(none)'}

## The change (against \`${input.base}\`)
${diffSection(input.diff, input.stat)}

## What to look at
Use the lenses that apply; do not force the rest.
- **Correctness**: edge cases, errors swallowed or lost, state left half-applied when a step fails, what happens when it runs twice. Trace the call chain that makes a value wrong instead of saying it "could" be.
- **Root causes**: a guard or a cast hiding a broken invariant; a fix in the wrong layer.
- **Fit**: does it follow this repository's conventions (read CLAUDE.md / AGENTS.md if present) and reuse its helpers? Does anything look bolted on — would it look like this had the requirement been known from the start? Old and new paths both left alive?
- **Across tickets**: tickets were reviewed one at a time; look for what only shows when they meet — two of them solving the same thing twice, an interface one provides and another uses differently, a gap no ticket owned.
- **Verification**: tests that test behaviour, not mocks; the real path exercised.
- **Complexity**: abstractions with one caller, parameters for cases that do not exist, dead code.
- **Security**: trace any input that reaches a dangerous sink.

A good finding names a location and shows why it is a problem. "I would have done it differently" is not a finding. Do not restate what the code does. An empty \`findings\` list is a valid outcome.

## Evidence
For EVERY acceptance criterion above, one entry in \`evidence\`: what you ran or read to check it, what you saw, and a result. **PASS only if you actually ran or inspected something that shows it.** If you could not check it (no way to run it here, it needs a browser or a device), the result is NOT_RUN and \`observed\` says why. UI behaviour you did not see rendered is NOT_RUN, never PASS.

${LANGUAGE_RULE.replace('the brief', 'the brief above')}`
}

export const BRANCH_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'nit'] },
          title: { type: 'string' },
          where: { type: 'string', description: 'file:line or function' },
          detail: { type: 'string', description: 'What is wrong and the evidence for it' },
          suggestion: { type: 'string', description: 'What to do instead; empty if none' },
        },
        required: ['severity', 'title', 'where', 'detail', 'suggestion'],
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string', description: 'The id given above, e.g. T1.2' },
          check: { type: 'string', description: 'The command you ran or the code you inspected' },
          observed: { type: 'string' },
          result: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
        },
        required: ['criterion', 'check', 'observed', 'result'],
      },
    },
  },
  required: ['findings', 'evidence'],
} as const

export interface BranchFinding {
  severity: 'critical' | 'warning' | 'nit'
  title: string
  where: string
  detail: string
  suggestion: string
}

export interface AcceptanceEvidence {
  criterion: string
  check: string
  observed: string
  result: 'PASS' | 'FAIL' | 'NOT_RUN'
}

export interface BranchReviewResult {
  findings: BranchFinding[]
  evidence: AcceptanceEvidence[]
}

/** One consolidated finding, as gate 2 shows it. */
export interface ReviewItem {
  title: string
  where: string
  detail: string
  /** Raised independently by more than one model family. */
  highConfidence: boolean
  /** Which reviewers raised it (provider ids). */
  raisedBy: string[]
  /** Dismissed only: why it does not hold. */
  reason?: string
}

export interface SpecReview {
  actOn: ReviewItem[]
  consider: ReviewItem[]
  noted: ReviewItem[]
  dismissed: ReviewItem[]
  /** One row per acceptance criterion, merged across reviewers. */
  evidence: (AcceptanceEvidence & { by: string })[]
  summary: string
}

const REVIEW_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    where: { type: 'string' },
    detail: { type: 'string' },
    highConfidence: { type: 'boolean' },
    raisedBy: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['title', 'where', 'detail', 'highConfidence', 'raisedBy'],
} as const

export const SPEC_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    actOn: { type: 'array', items: REVIEW_ITEM },
    consider: { type: 'array', items: REVIEW_ITEM },
    noted: { type: 'array', items: REVIEW_ITEM },
    dismissed: { type: 'array', items: REVIEW_ITEM },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...BRANCH_REVIEW_SCHEMA.properties.evidence.items.properties, by: { type: 'string' } },
        required: ['criterion', 'check', 'observed', 'result', 'by'],
      },
    },
    summary: { type: 'string', description: 'Two or three sentences: is this change ready, and what decides it' },
  },
  required: ['actOn', 'consider', 'noted', 'dismissed', 'evidence', 'summary'],
} as const

export function consolidateReviewPrompt(input: {
  design: string
  tickets: SpecTicket[]
  reviews: { reviewer: string; result: BranchReviewResult }[]
}): string {
  return `You are the lead. Independent reviewers from different model families reviewed the finished change below. Merge what they found into one verdict the user will sign at the final gate. You have the checkout: verify a finding against the code before you keep or dismiss it.

## Sort every finding into exactly one pile
- **actOn** — a real defect: wrong behaviour, a failed acceptance criterion, a security hole, damage you would block a merge over. These are fixed automatically before the user sees the change, so only what is clearly worth a fix round.
- **consider** — a real concern a reasonable person might accept: a design risk, a maintainability cost. Left for the user to decide.
- **noted** — true but minor: polish, naming, small cleanups.
- **dismissed** — does not hold. \`reason\` is required: the call site that rules it out, the convention it matches, the constraint the reviewer could not see.

The same problem raised by more than one reviewer is ONE item with every reviewer in \`raisedBy\` and \`highConfidence\` true — independent agreement across families is the strongest signal there is. Be careful dismissing a high-confidence item, a security finding or a correctness bug.

## How to judge
- **Nitpick gravity**: reviewers fill their review. If everything a reviewer found is a nit, the code is probably fine — say so.
- **Hypothetical vs. actual**: "what if this is null" counts only if a caller can make it null. Trace it.
- **"I would have done it differently"** is not a defect unless it shows a concrete problem. Dismiss it and say why.
- **Missing context**: findings about code the change did not touch, or patterns consistent with the rest of the codebase, are honest mistakes — dismiss them gracefully.

## Evidence
One \`evidence\` row per acceptance criterion. Where reviewers disagree, keep the stricter result unless you can show it is wrong; \`by\` names who produced the row. Never turn NOT_RUN into PASS without running the check yourself.

## The design
${input.design}

## Acceptance criteria
${ticketChecklist(input.tickets)}

## The reviews
${input.reviews.map((r) => `### Reviewer: ${r.reviewer}\n\`\`\`json\n${JSON.stringify(r.result, null, 2)}\n\`\`\``).join('\n\n')}

${LANGUAGE_RULE.replace('the brief', 'the design')}`
}

/** The fix ticket built from the act-on items: what it delivers and how to know it is done. */
export function reviewFixesTicket(key: string, items: ReviewItem[]): SpecTicket {
  return {
    key,
    title: 'Review fixes',
    delivers: 'The change as a whole passed review except for the points below; fix each of them, and nothing else.',
    acceptance: items.map((i) => `${i.title} (${i.where}): ${i.detail}`),
    blockedBy: [],
    interfaces: [],
  }
}

export function recheckPrompt(input: { review: SpecReview; diff: string; stat: string }): string {
  return `You are the lead. Your review of a change found the "act on" items below, and a fix round was built for them. Check the fix only: for each item, is the defect gone? Look at the fix diff and the code it touches, run what you need.

Return the review with every addressed item removed from \`actOn\` (keep the ones still open, with what is still wrong in \`detail\`), anything the fix itself broke added to \`actOn\`, the evidence rows updated for criteria the fix affects, and \`summary\` rewritten. Leave consider / noted / dismissed as they are.

## The review
\`\`\`json
${JSON.stringify(input.review, null, 2)}
\`\`\`

## The fix diff
${diffSection(input.diff, input.stat)}

${LANGUAGE_RULE.replace('the brief', 'the review')}`
}

export function integrationReviewPrompt(input: {
  review: SpecReview
  target: string
  files: string[]
  summary: string
  diff: string
  stat: string
}): string {
  return `You review how a merge was resolved. The change below was reviewed (the review is included) and was being signed off, but merging \`${input.target}\` into it conflicted in ${input.files.map((f) => `\`${f}\``).join(', ') || 'some files'}. Another agent resolved the merge. The diff shows only how the result differs from what git produced on its own: conflicted files appear with git's conflict markers on the old side, and anything else the agent changed appears too.

Check that the resolution keeps both sides: the change's behaviour as reviewed, and what \`${input.target}\` added. Look for dropped code from either side, a side taken wholesale where both were needed, and changes that go beyond resolving the conflict. Your checkout is the merged result; run what you need.

Return the review with anything the resolution broke or dropped added to \`actOn\` (raisedBy: your provider), the evidence rows updated for criteria the resolution affects, and \`summary\` rewritten to say how the merge was resolved. Leave the other items as they are.

## The review
\`\`\`json
${JSON.stringify(input.review, null, 2)}
\`\`\`

## What the agent says it did
${input.summary || '(nothing)'}

## The resolution, against git's own merge
${diffSection(input.diff, input.stat)}

${LANGUAGE_RULE.replace('the brief', 'the review')}`
}

/** review.md — the gate 2 document, rendered from the consolidated review. */
export function renderReview(review: SpecReview, opts: { fixed: number; base: string }): string {
  const item = (i: ReviewItem) =>
    `- **${i.title}** — \`${i.where}\`${i.highConfidence ? ' · high confidence' : ''} · ${i.raisedBy.join(', ')}\n  ${i.detail}${i.reason ? `\n  Why dismissed: ${i.reason}` : ''}`
  const section = (title: string, items: ReviewItem[]) =>
    `## ${title} (${items.length})\n${items.length > 0 ? items.map(item).join('\n') : '_none_'}`
  const evidence = [
    '| Criterion | Result | Check | Observed | By |',
    '|---|---|---|---|---|',
    ...review.evidence.map(
      (e) => `| ${e.criterion} | ${e.result} | ${cell(e.check)} | ${cell(e.observed)} | ${e.by} |`,
    ),
  ].join('\n')
  return [
    `# Review`,
    review.summary,
    opts.fixed > 0 ? `_${opts.fixed} act-on item(s) were fixed in a review-fix round before this report._` : '',
    section('Act on', review.actOn),
    section('Consider', review.consider),
    section('Noted', review.noted),
    section('Dismissed', review.dismissed),
    `## Acceptance evidence (against \`${opts.base}\`)\n${evidence}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

// ---------------------------------------------------------------------------
// Gate 2: what the change leaves behind (ADRs and glossary)
// ---------------------------------------------------------------------------

/**
 * The decisions and terms the repository already records, for the roles that
 * must not contradict them. Built by the server from `docs/adr/` and
 * `GLOSSARY.md`; empty when the repository has neither.
 */
export function recordedSection(recorded: string): string {
  if (!recorded) return ''
  return `\n## Already recorded in this repository\nDecisions in docs/adr/ stand until a new ADR supersedes them; use the glossary's terms as defined. If the change needs to go against one, say so explicitly.\n\n${recorded}\n`
}

export const DECISIONS_SCHEMA = {
  type: 'object',
  properties: {
    adrs: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Short kebab-case, ASCII, e.g. "reminders-own-table"' },
          title: { type: 'string', description: 'The decision as one sentence' },
          context: { type: 'string', description: 'Markdown: the forces that made a decision necessary' },
          decision: { type: 'string', description: 'Markdown: what was decided' },
          consequences: { type: 'string', description: 'Markdown: what follows, including the alternatives turned down and why' },
          supersedes: { type: ['number', 'null'], description: 'Number of the recorded ADR this replaces, or null' },
        },
        required: ['slug', 'title', 'context', 'decision', 'consequences', 'supersedes'],
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          definition: { type: 'string', description: 'One or two sentences, in the domain\'s own words' },
        },
        required: ['term', 'definition'],
      },
    },
  },
  required: ['adrs', 'glossary'],
} as const

export interface DecisionsResult {
  adrs: { slug: string; title: string; context: string; decision: string; consequences: string; supersedes: number | null }[]
  glossary: { term: string; definition: string }[]
}

export function decisionsPrompt(input: {
  brief: string
  answers: string | null
  design: string
  synthesis: string | null
  rulings: string[]
  recorded: string
}): string {
  return `You are the lead. The change below is built and reviewed, and the user is about to sign it off. Decide what it should leave behind for whoever works on this code next. Everything you return is written into the repository: architecture decision records under docs/adr/ (one short file per decision, never edited afterwards) and new terms in GLOSSARY.md.

## ADRs — usually none or one, never more than three
Record a decision only if either holds:
- someone could plausibly propose an alternative this change turned down, and should find out why it lost;
- the code alone does not show why it is shaped this way.
Implementation detail, naming, and anything obvious from reading the code do not qualify. An empty list is the common, correct answer. If a decision changes one already recorded, write a new ADR and put the old one's number in \`supersedes\`; never restate a recorded decision.

## Glossary — domain terms only
Add a term this change introduced or pinned down that a newcomer would not know, as the brief and design use it. No general technical vocabulary, and nothing the glossary already defines.

## Brief
${input.brief}
${decisionsSince(input.answers)}
## Design
${input.design}
${input.synthesis ? `\n## Synthesis note (what was chosen, grafted and rejected)\n${input.synthesis}\n` : ''}${input.rulings.length > 0 ? `\n## Rulings the implementers made\n${input.rulings.map((r) => `- ${r}`).join('\n')}\n` : ''}${recordedSection(input.recorded)}
${LANGUAGE_RULE}`
}

// ---------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------

/** Times the coordinator may set one ticket going again before a block goes to the user. */
export const MAX_COORDINATOR_RETRIES = 2

/**
 * The coordinator agent's standing instructions. One agent per seat serves every
 * spec, so nothing here is about a particular spec; each wake-up message says which.
 */
export const COORDINATOR_INSTRUCTIONS = `You are the coordinator of OperonSpec changes. A spec is one change: agents design it (explorers, design candidates, a judge, the lead), the user approves the design, it is split into tickets, and the tickets are built by implementer agents, each reviewed by another model family and merged into the spec's change branch. That machinery runs on rules without you. You are woken for what needs judgement: a step that failed, a ticket that is stuck, a conflict when the user signs the change off, or a message from the user. Each message names the spec (#N); between messages you sleep.

Before the design is approved you only deal with failures — never with the design itself: candidates, the judge's scores and questions for the user follow their own course, and you never answer the user's questions for them.

The user talks to the spec in the chat it was started from; what you hand them (spec_propose_switch, spec_escalate) reaches them there, and their answers come back to you as messages.

Your session runs in the spec's change worktree (branch operon/task-N). The spec's files are in .operon/changes/task-N/: brief.md, design.md (what was approved), tickets.json, review.md.

Tools (taskboard): spec_status reads where the spec and every ticket stand, and which agent plays each role; get_project_task reads a task with its activity (an implementer's report is its last comment); comment_project_task answers on a task; spec_retry_ticket sets a blocked ticket going again with your instructions; spec_add_ticket adds a ticket the build is missing; spec_propose_switch asks the user to move a role (a ticket's implementer or reviewer, the spec's reviewer, …) to another agent or model; spec_escalate hands something to the user; spec_integration_done hands in a resolved sign-off conflict.

When the trouble is the agent rather than the work — out of quota or rate-limited, not logged in, a provider error, a model that will not start, or one that keeps failing the same way — retrying on the same agent will not help: call spec_propose_switch with the role, the agent (and model) to move it to, and why. Pick from the agents spec_status lists as usable here. Never switch without asking: the user decides, and the switch and the work carrying on follow from their yes.

Rules:
- Never change what the user approved. A problem that needs a different design goes to the user with spec_escalate, with what you found and what you recommend.
- Never merge into the default branch, and never sign anything off: that is the user's.
- Don't build tickets yourself; implementers do. Change code only to resolve a merge you were asked to resolve. Never edit files under .operon/changes/.
- Decide small things the design left open yourself, and say so as a ruling.
- When you have dealt with the message, end your turn. Write anything the user reads in the language of the spec's brief.`

export function blockedTicketMessage(input: {
  specNumber: number
  ticketNumber: number
  ticketKey: string
  reason: string
  retriesLeft: number
}): string {
  return [
    `Ticket #${input.ticketNumber} (${input.ticketKey}) of spec #${input.specNumber} is blocked: ${input.reason}`,
    '',
    `Find out why: spec_status(task: ${input.specNumber}), get_project_task(task: ${input.ticketNumber}) for its report and the reviews, ` +
      `and its branch operon/task-${input.ticketNumber} (git log / git diff against operon/task-${input.specNumber}). Then do one of:`,
    `- spec_retry_ticket(task: ${input.specNumber}, ticket: ${input.ticketNumber}, instructions: ...) — when its implementer can finish with clearer instructions ` +
      `(add a ruling when you decide something the design left open). ${input.retriesLeft > 0 ? `You can do this ${input.retriesLeft} more time(s) for this ticket.` : 'You cannot retry this ticket again.'}`,
    `- spec_add_ticket(task: ${input.specNumber}, ...) — when work is missing that another ticket should do first or alongside.`,
    `- spec_propose_switch(task: ${input.specNumber}, role: "implementer", ticket: ${input.ticketNumber}, provider: ..., reason: ...) — when its agent is the problem (quota, auth, a provider error, a model that will not start); the user decides.`,
    `- spec_escalate(task: ${input.specNumber}, ticket: ${input.ticketNumber}, message: ...) — when the design is wrong, or retrying will not help. Say what you found and what you recommend.`,
    'If you do none of these, the user is told the ticket is blocked when your turn ends.',
  ].join('\n')
}

/**
 * What the chat a spec was started from is told when the spec needs the user —
 * the one conversation they talk to the spec in. Its agent passes it on and acts
 * on their answer; the coordinator works in the background.
 */
export function specNoticeText(specNumber: number, body: string): string {
  return [
    `<spec-notice spec="${specNumber}">`,
    body,
    '</spec-notice>',
    `This is about spec #${specNumber}, which this chat started. Tell the user in a sentence or two, in their language, and stop. ` +
      'When they answer: spec_switch_agent makes a switch they agree to (it carries the spec on), spec_decline_switch turns a proposed ' +
      `one down, and spec_message_coordinator passes anything else to the spec's coordinator. spec_status(task: ${specNumber}) says where it stands.`,
  ].join('\n')
}

/** A step of the build stopped on an error: the coordinator looks first. */
export function stepFailedMessage(input: { specNumber: number; step: string; reason: string; role?: string; ticketNumber?: number }): string {
  const target = input.role
    ? `role: "${input.role}"${input.ticketNumber != null ? `, ticket: ${input.ticketNumber}` : ''}`
    : 'role: ...'
  return [
    `Spec #${input.specNumber} stopped: ${input.step} failed — ${input.reason}`,
    '',
    `If the agent is the problem (out of quota, rate-limited, not logged in, a provider error, a model that will not start), ` +
      `call spec_propose_switch(task: ${input.specNumber}, ${target}, provider: ..., reason: ...): if the user agrees, the step runs again on that agent. ` +
      `Otherwise tell the user what went wrong with spec_escalate(task: ${input.specNumber}, message: ...); they can resume the spec once it is dealt with.`,
  ].join('\n')
}

export function integrationMessage(input: { specNumber: number; branch: string; target: string; files: string[] }): string {
  return [
    `The user signed spec #${input.specNumber} off, but merging \`${input.target}\` into \`${input.branch}\` conflicts in ${input.files.map((f) => `\`${f}\``).join(', ') || 'some files'}.`,
    '',
    `In your worktree (it is on \`${input.branch}\`): run \`git merge ${input.target}\`, and resolve every conflict so both sides survive — ` +
      `the change as it was reviewed, and what \`${input.target}\` added since. Don't change anything else. Run the checks from the acceptance ` +
      `criteria in tickets.json that cover the files you touched. Commit the merge, then call spec_integration_done(task: ${input.specNumber}, ` +
      'summary: how you resolved each file and what you ran). A reviewer from another model family checks the result before the user signs off again.',
    `If it cannot be resolved without changing what the change does, run \`git merge --abort\` and call spec_escalate(task: ${input.specNumber}, message: ...) instead.`,
  ].join('\n')
}
