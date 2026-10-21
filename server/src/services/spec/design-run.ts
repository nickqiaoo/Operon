/**
 * The design stage of a spec: ③ Ground and ④ Design, run in the background.
 *
 *   grounding  — explorers over fixed angles → explainer → grounding.md
 *   designing  — lead's private rubric → N candidates in parallel → judge on
 *                another family → lead synthesis → builder check → triage
 *                → (questions for the user?) → tickets
 *
 * Every step is idempotent on the change branch: a step whose output file
 * already exists is skipped. That is the whole resume story — stop, fail, quit
 * the app, answer the user's questions or ask for changes, and the next run
 * picks up at the first missing file. No journal to replay.
 *
 * Each run is recorded as a workflow run (same event log, same panel tab), so
 * the user watches every agent stream live, and when the run ends its result is
 * delivered back to the chat that started the spec — which is how the chat
 * agent learns that there are questions to ask or a design to present.
 */

import { newAgentId } from 'operon-agents'
import type { TaskStorageAdapter } from '../../storage/interface.js'
import type { Task } from '../../types/task.js'
import type { SpecQuestion, SpecRun, SpecStage, SpecTicket } from '../../types/spec.js'
import { appendEvent, markExecuting, readRunView, unmarkExecuting } from '../workflow/store.js'
import { registerWorkflowAbort, unregisterWorkflowAbort } from '../workflow/registry.js'
import { RunEventWriter } from '../workflow/writer.js'
import { deliverWorkflowResult } from '../workflow/completion.js'
import { broadcastTask } from '../task-events.js'
import { SpecAgents } from './agents.js'
import { candidateKey } from './config.js'
import { readRecorded } from './decisions.js'
import {
  SPEC_FILES,
  candidateFile,
  listCandidateKeys,
  readSpecFile,
  readSpecJson,
  writeSpecFiles,
  type SpecLocation,
} from './files.js'
import {
  CANDIDATE_DIRECTIONS,
  GROUNDING_ANGLES,
  RUBRIC_SCHEMA,
  SYNTHESIS_SCHEMA,
  TICKETS_SCHEMA,
  TRIAGE_SCHEMA,
  REVISE_SCHEMA,
  answersNeededNext,
  builderCheckPrompt,
  builderFoundNothing,
  candidatePrompt,
  designReadyNext,
  explainerPrompt,
  explorerPrompt,
  judgePrompt,
  revisePrompt,
  rubricPrompt,
  synthesisPrompt,
  ticketsPrompt,
  triagePrompt,
  type SynthesisResult,
  type TriageResult,
} from './prompts.js'

/** The builder check's raw questions — its presence means the check already ran. */
export const BUILDER_FILE = 'builder.md'

/**
 * Questions waiting for the user. `diverged`: the candidates disagreed so much
 * that the brief must be sharpened before synthesis. `builder`: the builder
 * check left questions only the user can answer.
 */
export interface PendingQuestions {
  kind: 'diverged' | 'builder'
  questions: SpecQuestion[]
}

/** What the run hands back to the chat, inside its <workflow-result>. */
export interface SpecRunResult {
  operonSpec: {
    task: number
    stage: SpecStage
    questions?: SpecQuestion[]
    next: string
  }
}

type SpecRunStorage = TaskStorageAdapter

/** Spec runs executing in this process, by task id. One at a time per spec. */
const activeRuns = new Map<number, AbortController>()

export function isDesignRunActive(taskId: number): boolean {
  return activeRuns.has(taskId)
}

export function stopDesignRun(taskId: number): boolean {
  const controller = activeRuns.get(taskId)
  if (!controller) return false
  controller.abort()
  return true
}

export interface DesignRunInput {
  storage: SpecRunStorage
  task: Task
  run: SpecRun
  loc: SpecLocation
  chatId: number | null
  /**
   * The run failed: hand it to the spec's coordinator. True when it took it on —
   * then it, not this run, reports to the chat (with a switch to propose, say).
   */
  onFailed?: (error: string) => Promise<boolean>
}

/** Start the design stage detached. Returns the workflow run id the progress is recorded under. */
export function startDesignRun(input: DesignRunInput): string {
  if (activeRuns.has(input.task.id)) {
    throw new Error(`Spec #${input.task.number} is already running`)
  }
  // One spec, one run: a resume, an answer or a redesign continues the run the
  // spec already has — `started` again under its id, as a resumed Workflow run
  // does — so the Workflow tab shows the spec once, with all its agents.
  const previous = input.run.workflowRunId ? readRunView(input.run.workflowRunId) : undefined
  const runId = previous?.runId ?? newAgentId('spec')
  const controller = new AbortController()
  activeRuns.set(input.task.id, controller)
  appendEvent(runId, {
    kind: 'started',
    chatId: input.chatId,
    name: `OperonSpec #${input.task.number}`,
    description: input.task.title,
    // Not a workflow script: a spec resumes from its files, not by replay.
    script: '',
    startedAt: Date.now(),
    ...(previous ? { resumed: true } : {}),
  })
  input.storage.specRunUpdate(input.task.id, { workflowRunId: runId, error: null })
  void execute(input, runId, controller)
  return runId
}

async function execute(input: DesignRunInput, runId: string, controller: AbortController): Promise<void> {
  const { storage, task } = input
  const writer = new RunEventWriter(runId)
  markExecuting(runId)
  registerWorkflowAbort(runId, controller)

  const setStage = (stage: SpecStage, error: string | null = null) => {
    storage.specRunUpdate(task.id, { stage, error })
    broadcastTask(storage, task.id)
  }

  let status: 'completed' | 'failed' | 'stopped' = 'completed'
  let result: SpecRunResult | undefined
  let error: string | undefined
  try {
    result = await designStage(input, writer, controller.signal, setStage)
  } catch (err) {
    if (controller.signal.aborted) {
      status = 'stopped'
      setStage('stopped')
    } else {
      status = 'failed'
      error = err instanceof Error ? err.message : String(err)
      setStage('failed', error)
      storage.taskAppendActivity(task.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'OperonSpec',
        body: `The design run stopped with an error: ${error}`,
      })
    }
  } finally {
    appendEvent(runId, { kind: 'settled', status, endedAt: Date.now(), error, result })
    writer.dispose()
    unregisterWorkflowAbort(runId)
    unmarkExecuting(runId)
    activeRuns.delete(task.id)
  }

  // A failure goes to the coordinator first: the usual cause is an agent (out of
  // quota, logged out), and it comes back to the chat with what to switch.
  if (status === 'failed' && error != null && input.onFailed && (await input.onFailed(error).catch(() => false))) return
  // A run the user stopped needs no report; anything else goes back to the chat
  // so its agent can ask the questions, present the design, or explain the failure.
  if (status !== 'stopped') {
    const view = readRunView(runId)
    if (view) void deliverWorkflowResult(view)
  }
}

async function designStage(
  input: DesignRunInput,
  writer: RunEventWriter,
  signal: AbortSignal,
  setStage: (stage: SpecStage) => void,
): Promise<SpecRunResult> {
  const { task, run, loc } = input
  const config = run.config
  // A continued run keeps its earlier agents; new ones are numbered after them.
  const earlier = readRunView(writer.runId)?.agents ?? []
  const firstIndex = earlier.reduce((max, a) => Math.max(max, a.index + 1), 0)
  const agents = new SpecAgents({
    writer,
    cwd: loc.worktreePath,
    chatId: input.chatId,
    workspaceId: task.workspaceId ?? null,
    signal,
    firstIndex,
    // As at start: only the lead's own provider brings the chat's model along.
    modelFor: (providerId) => (providerId === config.lead.providerId ? config.lead.modelId : undefined),
    // The role keeps its new provider — the rest of this run, retries and resumes.
    onSeatReplaced: (seat, to) => {
      seat.providerId = to.providerId
      if (to.modelId) seat.modelId = to.modelId
      else delete seat.modelId
      input.storage.specRunUpdate(task.id, { config })
      broadcastTask(input.storage, task.id)
    },
  })
  // Each phase title is announced once, the first time a step under it actually runs.
  const phases: string[] = []
  const phase = (title: string) => {
    if (phases.includes(title)) return
    writer.emit({ kind: 'phase', index: phases.length, title })
    phases.push(title)
  }
  const leadName = config.lead.providerId

  const brief = await readSpecFile(loc, SPEC_FILES.brief)
  if (!brief) throw new Error(`Spec #${task.number} has no brief.md`)

  // ③ Ground ---------------------------------------------------------------
  let grounding = await readSpecFile(loc, SPEC_FILES.grounding)
  if (!grounding) {
    setStage('grounding')
    phase('Ground')
    const findings = await Promise.allSettled(
      GROUNDING_ANGLES.map(async (angle) => ({
        angle: angle.title,
        text: await agents.text({
          label: `explorer · ${angle.title}`,
          phase: 'Ground',
          seat: config.explorer,
          prompt: explorerPrompt(brief, angle),
        }),
      })),
    )
    signal.throwIfAborted()
    const found = findings.flatMap((f) => (f.status === 'fulfilled' ? [f.value] : []))
    if (found.length === 0) throw new Error(firstRejection(findings) ?? 'every explorer failed')
    grounding = await agents.text({
      label: `explainer · ${leadName}`,
      phase: 'Ground',
      seat: config.lead,
      prompt: explainerPrompt(brief, found),
    })
    await writeSpecFiles(loc, { [SPEC_FILES.grounding]: grounding }, 'grounding')
  }

  setStage('designing')
  // The ADRs and glossary the repository already has: designs must not quietly contradict them.
  const recorded = await readRecorded(loc.worktreePath)
  const answers = await readSpecFile(loc, SPEC_FILES.answers)
  const feedback = await readSpecFile(loc, SPEC_FILES.feedback)
  let pending = await readSpecJson<PendingQuestions>(loc, SPEC_FILES.questions)

  // Questions still waiting for the user: nothing more can happen until they answer.
  if (pending && !answeredSince(answers, pending)) {
    return askUser(task, pending, setStage)
  }

  // ④ Design: rubric → candidates → judge --------------------------------
  let rubric = await readSpecJson<{ criteria: string[] }>(loc, SPEC_FILES.rubric)
  if (!rubric) {
    phase('Design')
    rubric = await agents.json<{ criteria: string[] }>(
      { label: `rubric · ${leadName}`, phase: 'Design', seat: config.lead, prompt: rubricPrompt(brief, grounding) },
      RUBRIC_SCHEMA,
    )
    await writeSpecFiles(loc, { [SPEC_FILES.rubric]: JSON.stringify(rubric, null, 2) }, 'rubric')
  }

  const present = new Set(await listCandidateKeys(loc))
  const missing = config.candidates
    .map((seat, i) => ({ seat, key: candidateKey(i), direction: CANDIDATE_DIRECTIONS[i % CANDIDATE_DIRECTIONS.length] }))
    .filter((c) => !present.has(c.key))
  if (missing.length > 0) {
    phase('Design')
    const outcomes = await Promise.allSettled(
      missing.map(async (c) => {
        const text = await agents.text({
          label: `candidate ${c.key} · ${c.seat.providerId}`,
          phase: 'Design',
          seat: c.seat,
          prompt: candidatePrompt(brief, grounding as string, c.direction, recorded),
        })
        // Saved as each one lands, so a failure elsewhere never costs a finished candidate.
        await writeSpecFiles(loc, { [candidateFile(c.key)]: text }, `candidate ${c.key}`)
      }),
    )
    signal.throwIfAborted()
    const keys = await listCandidateKeys(loc)
    if (keys.length < 2) {
      throw new Error(
        `Only ${keys.length} design candidate(s) finished; a spec needs at least two to compare. ` +
          (firstRejection(outcomes) ?? ''),
      )
    }
    // New candidates make any earlier judgement and synthesis stale.
    await writeSpecFiles(loc, { [SPEC_FILES.judge]: null, [SPEC_FILES.design]: null }, 'new candidates')
  }

  const candidates = await Promise.all(
    (await listCandidateKeys(loc)).map(async (key) => ({
      key,
      provider: config.candidates[key.charCodeAt(0) - 65]?.providerId ?? '?',
      text: (await readSpecFile(loc, candidateFile(key))) ?? '',
    })),
  )

  let judge = await readSpecFile(loc, SPEC_FILES.judge)
  if (!judge) {
    phase('Judge')
    judge = await agents.text({
      label: `judge · ${config.judge.providerId}`,
      phase: 'Judge',
      seat: config.judge,
      prompt: judgePrompt(brief, rubric.criteria, candidates),
    })
    await writeSpecFiles(loc, { [SPEC_FILES.judge]: judge }, 'judge')
  }

  // Synthesis ---------------------------------------------------------------
  let design = await readSpecFile(loc, SPEC_FILES.design)
  if (!design) {
    phase('Synthesize')
    const synthesis = await agents.json<SynthesisResult>(
      {
        label: `lead · ${leadName}`,
        phase: 'Synthesize',
        seat: config.lead,
        prompt: synthesisPrompt({ brief, grounding, criteria: rubric.criteria, candidates, judge, feedback, answers, recorded }),
      },
      SYNTHESIS_SCHEMA,
    )
    if (synthesis.verdict === 'diverged' && synthesis.underspecified?.length && !(pending?.kind === 'diverged')) {
      // Averaging wildly different designs produces something nobody chose.
      // Sharpen the brief with the user instead, then synthesize again.
      pending = {
        kind: 'diverged',
        questions: synthesis.underspecified.map((q) => ({
          question: q,
          // The question says it all; a fixed English line read oddly in any other language.
          why: '',
        })),
      }
      await writeSpecFiles(
        loc,
        { [SPEC_FILES.questions]: JSON.stringify(pending, null, 2), [SPEC_FILES.synthesis]: synthesis.synthesis },
        'candidates diverged — questions for the user',
      )
      return askUser(task, pending, setStage)
    }
    design = synthesis.design
    await writeSpecFiles(
      loc,
      {
        [SPEC_FILES.design]: design,
        [SPEC_FILES.synthesis]: synthesis.synthesis,
        // Answers to a divergence are consumed by this synthesis.
        ...(pending?.kind === 'diverged' ? { [SPEC_FILES.questions]: null } : {}),
        [BUILDER_FILE]: null,
        [SPEC_FILES.tickets]: null,
      },
      `design (base ${synthesis.base}, ${synthesis.verdict})`,
    )
    if (pending?.kind === 'diverged') pending = null
  }

  // ④-5 Builder check (once per design) ------------------------------------
  if (pending?.kind === 'builder') {
    // The user answered the builder's questions: fold the answers in.
    phase('Revise')
    const revised = await agents.json<{ design: string; calls: TriageResult['calls'] }>(
      {
        label: `lead · ${leadName}`,
        phase: 'Revise',
        seat: config.lead,
        prompt: revisePrompt(brief, design, pending.questions, answers ?? ''),
      },
      REVISE_SCHEMA,
    )
    design = revised.design
    await writeSpecFiles(
      loc,
      {
        [SPEC_FILES.design]: design,
        [SPEC_FILES.synthesis]: await withCalls(loc, revised.calls),
        [SPEC_FILES.questions]: null,
        [SPEC_FILES.tickets]: null,
      },
      'design revised with the user\'s answers',
    )
    pending = null
  } else if (!(await readSpecFile(loc, BUILDER_FILE))) {
    phase('Builder check')
    const builderQuestions = await agents.text({
      label: `builder check · ${config.builder.providerId}`,
      phase: 'Builder check',
      seat: config.builder,
      prompt: builderCheckPrompt(design),
    })
    await writeSpecFiles(loc, { [BUILDER_FILE]: builderQuestions }, 'builder check')
    if (!builderFoundNothing(builderQuestions)) {
      const triage = await agents.json<TriageResult>(
        {
          label: `lead · ${leadName}`,
          phase: 'Builder check',
          seat: config.lead,
          prompt: triagePrompt(brief, answers, design, builderQuestions),
        },
        TRIAGE_SCHEMA,
      )
      design = triage.design
      const files: Record<string, string | null> = {
        [SPEC_FILES.design]: design,
        [SPEC_FILES.synthesis]: await withCalls(loc, triage.calls),
      }
      if (triage.questions.length > 0) {
        pending = { kind: 'builder', questions: triage.questions }
        files[SPEC_FILES.questions] = JSON.stringify(pending, null, 2)
      }
      await writeSpecFiles(loc, files, 'design checked by a builder')
      if (pending) return askUser(task, pending, setStage)
    }
  }

  // ④-6 Tickets -------------------------------------------------------------
  if (!(await readSpecFile(loc, SPEC_FILES.tickets))) {
    phase('Tickets')
    let problem = ''
    let tickets: SpecTicket[] | null = null
    for (let attempt = 1; attempt <= 2 && !tickets; attempt++) {
      const reply = await agents.json<{ tickets: SpecTicket[] }>(
        {
          label: `tickets · ${leadName}`,
          phase: 'Tickets',
          seat: config.lead,
          prompt:
            ticketsPrompt(design, grounding) +
            (problem ? `\n\nYour previous breakdown was rejected: ${problem}. Fix it.` : ''),
        },
        TICKETS_SCHEMA,
      )
      problem = validateTickets(reply.tickets) ?? ''
      if (!problem) tickets = reply.tickets
    }
    if (!tickets) throw new Error(`The ticket breakdown is invalid: ${problem}`)
    await writeSpecFiles(loc, { [SPEC_FILES.tickets]: JSON.stringify(tickets, null, 2) }, `${tickets.length} tickets`)
  }

  setStage('awaiting_design')
  input.storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'OperonSpec',
    body: 'The design is ready for review.',
  })
  return { operonSpec: { task: task.number, stage: 'awaiting_design', next: designReadyNext(task.number) } }
}

function askUser(task: Task, pending: PendingQuestions, setStage: (stage: SpecStage) => void): SpecRunResult {
  setStage('awaiting_answers')
  return {
    operonSpec: {
      task: task.number,
      stage: 'awaiting_answers',
      questions: pending.questions,
      next: answersNeededNext(task.number),
    },
  }
}

/**
 * Whether answers.md holds answers to THIS round of questions. Answers are
 * appended under a heading that quotes the first question of their round.
 */
function answeredSince(answers: string | null, pending: PendingQuestions): boolean {
  if (!answers || pending.questions.length === 0) return false
  return answers.includes(roundMarker(pending))
}

export function roundMarker(pending: PendingQuestions): string {
  return `<!-- round: ${pending.kind}: ${pending.questions[0]?.question.slice(0, 80) ?? ''} -->`
}

/** synthesis.md with the lead's calls on the user's behalf appended (accumulates across rounds). */
async function withCalls(loc: SpecLocation, calls: TriageResult['calls']): Promise<string> {
  const current = (await readSpecFile(loc, SPEC_FILES.synthesis)) ?? ''
  if (calls.length === 0) return current
  const heading = '## Calls I made for you'
  const lines = calls.map((c) => `- **${c.question}** — ${c.decision}`).join('\n')
  return current.includes(heading) ? `${current.trimEnd()}\n${lines}\n` : `${current.trimEnd()}\n\n${heading}\n${lines}\n`
}

/** Null when the tickets form a valid graph; otherwise what is wrong, phrased for the lead. */
export function validateTickets(tickets: SpecTicket[]): string | null {
  const keys = new Set<string>()
  for (const t of tickets) {
    if (keys.has(t.key)) return `duplicate ticket key ${t.key}`
    keys.add(t.key)
  }
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      if (b === t.key) return `${t.key} blocks itself`
      if (!keys.has(b)) return `${t.key} is blocked by ${b}, which does not exist`
    }
  }
  return topologicalOrder(tickets) ? null : 'the blockedBy edges form a cycle'
}

/** Tickets ordered so every blocker comes before what it blocks; null on a cycle. */
export function topologicalOrder(tickets: SpecTicket[]): SpecTicket[] | null {
  const byKey = new Map(tickets.map((t) => [t.key, t]))
  const ordered: SpecTicket[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (t: SpecTicket): boolean => {
    const s = state.get(t.key)
    if (s === 'done') return true
    if (s === 'visiting') return false
    state.set(t.key, 'visiting')
    for (const b of t.blockedBy) {
      const blocker = byKey.get(b)
      if (blocker && !visit(blocker)) return false
    }
    state.set(t.key, 'done')
    ordered.push(t)
    return true
  }
  for (const t of tickets) if (!visit(t)) return null
  return ordered
}

function firstRejection(outcomes: PromiseSettledResult<unknown>[]): string | null {
  const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')
  if (!rejected) return null
  return rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason)
}
