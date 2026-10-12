import type { PermissionDecision, AgentSession } from '@operon/agent-runtime'
import type { Activity } from '../../../../shared/assistant.js'
import { WORKING_SUMMARY } from '../../../../shared/assistant.js'
import { AgentChannel, type AssistantProviderId, type OpenParams } from './agents.js'
import { ActivityProjector, type RunEnd, type WorkerFinish } from './projector.js'
import type { FinishArgs, HeartbeatArgs } from './tools.js'

/** A task the user asked for, the heartbeat, or a scheduled task. */
export type WorkerKind = 'task' | 'heartbeat' | 'schedule'

/** The limit a single worker run has, as the framework's own subagents had. */
const TIMEOUT_MS = 30 * 60_000
/** How much of what the user said is kept per worker (the newest part). */
const ASKED_LIMIT = 4_000

/** Which agent runs a worker. Empty `modelId`: the agent's own default. */
export interface WorkerAgent {
  providerId: AssistantProviderId
  modelId: string
}

/** The agent session a worker ran in — what "continue this task" resumes. */
export interface WorkerSessionRef extends WorkerAgent {
  sessionId: string
}

/**
 * A run in progress, as kept on disk until it ends. One still there when the app starts again was
 * cut off by the restart (workers live in this process), and this is what it takes to carry on.
 */
export interface InFlightRun {
  kind: WorkerKind
  unattended: boolean
  /** What this run was handed: the task's prompt, or a follow-up. */
  prompt: string
  /** The user's words behind it (WorkerSpec.asked). */
  asked?: string
}

/** What a worker cut off by an app restart is told when it is picked back up on its own session. */
const RESUME_PROMPT =
  'The app restarted while you were working on this task: your last step was cut off, and any command or process it started is gone. ' +
  'Pick up where you left off and finish the task. Steps that only read or wait (reading, listing, searching, fetching, sleeping) are safe: just run them again. ' +
  'Only for a step that sends, posts, buys or changes something, first check whether it already took effect, and never do it twice. ' +
  'Finish with finish_task as usual.'

export interface WorkerSpec {
  kind: WorkerKind
  title: string
  prompt: string
  /** Nobody is watching (heartbeat, schedule): steps that need a person are skipped, not asked. */
  unattended: boolean
  /** Shown in the Activity list from the start. A heartbeat run only shows up if it found something. */
  visible: boolean
  /** The user's words this worker was sent out on — what "they named this site" is judged against. */
  asked?: string
}

export interface WorkerOutcome {
  activity: Activity
  kind: WorkerKind
  end: RunEnd
  finish?: WorkerFinish
  finalText?: string
  error?: string
}

/** What the pool needs from the assistant runtime. */
export interface WorkerPoolHost {
  /** The agent workers of this kind run on (Settings). Throws when none is usable. */
  agentFor(kind: WorkerKind): Promise<WorkerAgent>
  /** The worker's instructions for a run of this kind. */
  instructions(kind: WorkerKind, unattended: boolean): string
  /** Where workers work. */
  cwd: string
  /** Outside `cwd`, writable as freely: the assistant's day notes. */
  writableDirs?: string[]
  /** Whether workers get node_repl (browser, Chrome, Mac apps). */
  nodeRepl(): boolean
  /** Open (or resume) an agent session. */
  open(params: OpenParams): Promise<AgentSession>
  /** Persist and broadcast. */
  activity(activity: Activity): void
  /** A stored activity, for picking a finished worker back up. */
  stored(activityId: string): Activity | undefined
  /** A call the worker's agent left to a person. */
  approve(activityId: string, toolName: string, input: unknown): Promise<PermissionDecision>
  saveSession(activityId: string, ref: WorkerSessionRef): void
  loadSession(activityId: string): WorkerSessionRef | undefined
  /** Keep a run on disk while it goes, so a restart can carry it on (InFlightRun). */
  saveRun(activityId: string, run: InFlightRun): void
  clearRun(activityId: string): void
  /** The worker's run ended; its activity is settled. */
  settled(outcome: WorkerOutcome): void
}

interface Run {
  kind: WorkerKind
  unattended: boolean
  visible: boolean
  agent: WorkerAgent
  channel: AgentChannel
  projector: ActivityProjector
  sessionId?: string
  /** Why the last turn failed, if it did. */
  lastError?: string
  end?: RunEnd
  done?: Promise<WorkerOutcome>
}

/**
 * The assistant's workers. Each one is an agent session of its own, a peer of the main agent's
 * rather than a subagent inside it: its own context, closed when it finishes and resumed if the
 * user picks the task back up. The main agent hears about it only through the notice the runtime
 * hands it when it finishes (docs/assistant/design.md §2).
 */
export class WorkerPool {
  private readonly runs = new Map<string, Run>()
  /** Per worker, what the user said that it acts on: its request, then each follow-up. Outlives
   *  the run, so a task picked back up still counts the sites of its original request. */
  private readonly asked = new Map<string, string>()

  constructor(
    private readonly host: WorkerPoolHost,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether any worker is mid-run — a change to the assistant's files now is likely its doing. */
  get anyRunning(): boolean {
    for (const run of this.runs.values()) if (run.end === undefined) return true
    return false
  }

  /** Live (or settling) workers — the ones a message or a stop can still reach. */
  isRunning(activityId: string): boolean {
    const run = this.runs.get(activityId)
    return run !== undefined && run.end === undefined
  }

  isUnattended(activityId: string): boolean {
    return this.runs.get(activityId)?.unattended ?? false
  }

  /** The user's words behind this worker ('' for a run nobody asked for, like the heartbeat). */
  askedFor(activityId: string): string {
    return this.asked.get(activityId) ?? ''
  }

  private addAsked(activityId: string, text: string | undefined): void {
    if (!text?.trim()) return
    const joined = [this.asked.get(activityId), text.trim()].filter(Boolean).join('\n')
    this.asked.set(activityId, joined.length > ASKED_LIMIT ? joined.slice(-ASKED_LIMIT) : joined)
  }

  setWaiting(activityId: string, waiting: boolean): void {
    this.runs.get(activityId)?.projector.setWaiting(waiting)
  }

  /** Worker `activityId` handed in its result. False: no running worker of that kind. */
  finish(activityId: string, args: FinishArgs): boolean {
    const run = this.runs.get(activityId)
    if (!run || run.kind === 'heartbeat') return false
    run.projector.handIn({ tool: 'finish_task', args })
    return true
  }

  /** The heartbeat run `activityId` handed in what it found. */
  heartbeatDone(activityId: string, args: HeartbeatArgs): boolean {
    const run = this.runs.get(activityId)
    if (!run || run.kind !== 'heartbeat') return false
    run.projector.handIn({ tool: 'heartbeat_done', args })
    return true
  }

  /** A milestone a running worker reported. */
  progress(activityId: string, text: string): boolean {
    const run = this.runs.get(activityId)
    if (!run || run.end !== undefined) return false
    run.projector.progress(text)
    return true
  }

  /** Start a worker. Resolves with its activity id once its session is open; the work goes on. */
  async start(spec: WorkerSpec): Promise<{ id: string; done: Promise<WorkerOutcome> }> {
    const id = this.newId()
    const activity: Activity = {
      id,
      taskId: `aw-${id}`,
      title: spec.title,
      summary: WORKING_SUMMARY,
      status: 'running',
      startedAt: this.now(),
      steps: [],
      ...(spec.kind !== 'task' ? { source: spec.kind } : {}),
    }
    this.addAsked(id, spec.asked)
    const agent = await this.host.agentFor(spec.kind)
    const session = await this.host.open(this.openParams(id, agent, spec.kind, spec.unattended))
    const run = this.attach(session, activity, spec.kind, spec.unattended, spec.visible, agent)
    if (spec.visible) run.projector.publish()
    const done = this.drive(id, run, spec.prompt)
    run.done = done
    return { id, done }
  }

  /**
   * More instructions for a worker: folded into its current run, or — once it has finished —
   * a new run of the same agent session, so it still has everything it did. Picked up by the
   * user, so it is attended from here on whatever started it.
   * @param asked the user's words behind this follow-up (see WorkerSpec.asked).
   */
  async continue(activityId: string, text: string, asked?: string): Promise<'delivered' | 'continued' | 'missing'> {
    const live = this.runs.get(activityId)
    if (live && live.end === undefined) {
      this.addAsked(activityId, asked)
      await live.channel.deliver({ text })
      live.projector.note(text)
      return 'delivered'
    }
    if (live) await live.done?.catch(() => undefined)
    const activity = this.host.stored(activityId)
    if (!activity) return 'missing'
    this.addAsked(activityId, asked)
    // Picked up by the user, a heartbeat or scheduled run becomes an ordinary task: the main
    // agent hears how it ended. Its activity keeps its source.
    const kind: WorkerKind = 'task'
    const ref = this.host.loadSession(activityId)
    let session: AgentSession | undefined
    let agent: WorkerAgent | undefined
    let prompt = text
    if (ref) {
      // The same agent that did it, on its own session: everything it did is still there.
      try {
        agent = { providerId: ref.providerId, modelId: ref.modelId }
        session = await this.host.open({ ...this.openParams(activityId, agent, kind, false), sessionId: ref.sessionId })
      } catch (error) {
        console.warn('[assistant] could not resume a worker session, starting over:', error)
        session = undefined
      }
    }
    if (!session) {
      // Its session is gone (or never existed). Start over, told what the user saw it produce.
      agent = await this.host.agentFor(kind)
      session = await this.host.open(this.openParams(activityId, agent, kind, false))
      prompt = `Earlier you worked on "${activity.title}". What came of it:\n${activity.report ?? activity.summary}\n\nNow: ${text}`
    }
    const run = this.attach(session, activity, kind, false, true, agent!)
    run.projector.reopen()
    run.projector.note(text)
    run.done = this.drive(activityId, run, prompt)
    return 'continued'
  }

  /**
   * Carry on a task the last run of the app cut off: on its own agent session when it had one
   * (everything it did is still there), else from the prompt it started with. Its activity is
   * picked up where it stopped, steps kept.
   */
  async resume(activityId: string, cut: InFlightRun): Promise<boolean> {
    const activity = this.host.stored(activityId)
    if (!activity || this.runs.has(activityId)) return false
    this.addAsked(activityId, cut.asked)
    const ref = this.host.loadSession(activityId)
    let session: AgentSession | undefined
    let agent: WorkerAgent | undefined
    let prompt = cut.prompt
    if (ref) {
      try {
        agent = { providerId: ref.providerId, modelId: ref.modelId }
        session = await this.host.open({ ...this.openParams(activityId, agent, cut.kind, cut.unattended), sessionId: ref.sessionId })
        prompt = RESUME_PROMPT
      } catch (error) {
        console.warn('[assistant] could not resume an interrupted worker session, starting it over:', error)
        session = undefined
      }
    }
    if (!session) {
      agent = await this.host.agentFor(cut.kind)
      session = await this.host.open(this.openParams(activityId, agent, cut.kind, cut.unattended))
      prompt = cut.prompt
    }
    const run = this.attach(session, activity, cut.kind, cut.unattended, true, agent!)
    run.projector.reopen()
    run.done = this.drive(activityId, run, prompt)
    return true
  }

  async stop(activityId: string): Promise<boolean> {
    const run = this.runs.get(activityId)
    if (!run || run.end !== undefined) return false
    run.end = 'stopped'
    run.channel.abort()
    return true
  }

  /** Every live worker, stopped — the app is going away. */
  async closeAll(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.stop(id)
    await Promise.allSettled([...this.runs.values()].flatMap((r) => (r.done ? [r.done] : [])))
  }

  private openParams(id: string, agent: WorkerAgent, kind: WorkerKind, unattended: boolean): OpenParams {
    return {
      providerId: agent.providerId,
      modelId: agent.modelId,
      kind: unattended ? 'unattended' : 'worker',
      caller: { role: 'worker', id },
      cwd: this.host.cwd,
      ...(this.host.writableDirs?.length ? { writableDirs: this.host.writableDirs } : {}),
      instructions: this.host.instructions(kind, unattended),
      nodeRepl: this.host.nodeRepl(),
    }
  }

  private attach(session: AgentSession, activity: Activity, kind: WorkerKind, unattended: boolean, visible: boolean, agent: WorkerAgent): Run {
    const run = {} as Run
    Object.assign(run, {
      kind,
      unattended,
      visible,
      agent,
      projector: new ActivityProjector(
        activity,
        (a) => {
          if (run.visible) this.host.activity(a)
        },
        this.newId,
        this.now,
        this.host.cwd,
      ),
      channel: new AgentChannel(session, {
        onPart: (part) => {
          try {
            run.projector.part(part)
          } catch (error) {
            console.error('[assistant] failed to project a worker part', part.type, error)
          }
        },
        onTurnEnd: (end) => {
          run.projector.turnEnd(end)
          run.lastError = end.error
        },
        onApproval: (toolName, input) => this.host.approve(activity.id, toolName, input),
        onSessionId: (sessionId) => {
          // On disk straight away, not only when the run ends: a run cut off by a restart never
          // ends, and without its session it could only start over.
          if (run.sessionId !== sessionId) this.host.saveSession(activity.id, { ...agent, sessionId })
          run.sessionId = sessionId
        },
      }),
    })
    this.runs.set(activity.id, run)
    return run
  }

  private async drive(activityId: string, run: Run, prompt: string): Promise<WorkerOutcome> {
    const timer = setTimeout(() => {
      if (run.end !== undefined) return
      run.end = 'timed_out'
      run.channel.abort()
    }, TIMEOUT_MS)
    let error: string | undefined
    this.host.saveRun(activityId, {
      kind: run.kind,
      unattended: run.unattended,
      prompt,
      ...(this.asked.has(activityId) ? { asked: this.asked.get(activityId) } : {}),
    })
    try {
      await run.channel.deliver({ text: prompt })
      // Instructions folded in as the turn was ending become one more turn; those finish too.
      await run.channel.whenIdle()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
    if (run.end === undefined) run.end = error || run.lastError ? 'failed' : 'completed'
    const end = run.end
    run.projector.settle(end)
    const outcome: WorkerOutcome = {
      activity: run.projector.activity,
      kind: run.kind,
      end,
      ...(run.projector.finished ? { finish: run.projector.finished } : {}),
      ...(run.projector.finalText ? { finalText: run.projector.finalText } : {}),
      ...((error ?? run.projector.error) ? { error: error ?? run.projector.error } : {}),
    }
    const sessionId = run.sessionId ?? run.channel.sessionId
    if (sessionId) this.host.saveSession(activityId, { ...run.agent, sessionId })
    this.host.clearRun(activityId)
    await run.channel.dispose()
    if (this.runs.get(activityId) === run) this.runs.delete(activityId)
    try {
      this.host.settled(outcome)
    } catch (e) {
      console.error('[assistant] handling a finished worker failed:', e)
    }
    return outcome
  }
}
