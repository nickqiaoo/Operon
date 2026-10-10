import type { Agent, CreateSessionOptions, Harness, HarnessSession } from 'operon-agents'
import type { Activity } from '../../../../shared/assistant.js'
import { ActivityProjector, type RunEnd, type WorkerFinish } from './projector.js'

/** A task the user asked for, the heartbeat, or a scheduled task. */
export type WorkerKind = 'task' | 'heartbeat' | 'schedule'

/** Prefix of a worker's framework session id; the rest is its activity id. */
const SESSION_PREFIX = 'aw-'
/** The framework's own subagent limit, kept for workers in sessions of their own. */
const TIMEOUT_MS = 30 * 60_000
/** How much of what the user said is kept per worker (the newest part). */
const ASKED_LIMIT = 4_000

export function workerSessionId(activityId: string): string {
  return `${SESSION_PREFIX}${activityId}`
}

/** The activity id of a worker session, or undefined for any other session (the main agent's). */
export function workerOfSession(sessionId: string): string | undefined {
  return sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : undefined
}

type ApprovalHandler = NonNullable<Parameters<HarnessSession['setApprovalHandler']>[0]>

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
  harness(): Promise<Harness>
  /** The agent a worker runs as — per worker, so its tools can name it. */
  agent(activityId: string, kind: WorkerKind): Agent
  /** Permission policy for a session being opened, standing grants included. */
  permission(): CreateSessionOptions['permission']
  /** Persist and broadcast. */
  activity(activity: Activity): void
  /** A stored activity, for picking a finished worker back up. */
  stored(activityId: string): Activity | undefined
  approvalHandler(activityId: string): ApprovalHandler
  /** The worker's run ended; its activity is settled. */
  settled(outcome: WorkerOutcome): void
}

interface Run {
  kind: WorkerKind
  unattended: boolean
  visible: boolean
  session: HarnessSession
  projector: ActivityProjector
  end?: RunEnd
  done?: Promise<WorkerOutcome>
}

/**
 * The assistant's workers. Each one is a framework session of its own, a peer of the main
 * agent's rather than a subagent inside it: its own log, its own context, closed when it
 * finishes and reopened if the user picks the task back up. The main agent hears about it only
 * through the notices the runtime steers in when it finishes (docs/assistant/design.md §2).
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

  /** Start a worker. Resolves with its activity id once its session is open; the work goes on. */
  async start(spec: WorkerSpec): Promise<{ id: string; done: Promise<WorkerOutcome> }> {
    const id = this.newId()
    const activity: Activity = {
      id,
      taskId: workerSessionId(id),
      title: spec.title,
      summary: 'Working…',
      status: 'running',
      startedAt: this.now(),
      steps: [],
      ...(spec.kind !== 'task' ? { source: spec.kind } : {}),
    }
    this.addAsked(id, spec.asked)
    const harness = await this.host.harness()
    const session = await harness.createSession({
      id: workerSessionId(id),
      agent: this.host.agent(id, spec.kind),
      title: spec.title,
      permission: this.host.permission(),
    })
    const run = this.attach(session, activity, spec.kind, spec.unattended, spec.visible)
    if (spec.visible) run.projector.publish()
    const done = this.drive(id, run, spec.prompt)
    run.done = done
    return { id, done }
  }

  /**
   * More instructions for a worker: folded into its current run, or — once it has finished —
   * a new run of the same session, so it still has everything it did. Picked up by the user,
   * so it is attended from here on whatever started it.
   * @param asked the user's words behind this follow-up (see WorkerSpec.asked).
   */
  async continue(activityId: string, text: string, asked?: string): Promise<'delivered' | 'continued' | 'missing'> {
    const live = this.runs.get(activityId)
    if (live && live.end === undefined) {
      this.addAsked(activityId, asked)
      live.session.steer(text)
      live.projector.note(text)
      return 'delivered'
    }
    if (live) await live.done?.catch(() => undefined)
    const activity = this.host.stored(activityId)
    if (!activity) return 'missing'
    this.addAsked(activityId, asked)
    // Picked up by the user, a heartbeat or scheduled run becomes an ordinary task: the task
    // agent's tools, and the main agent hears how it ended. Its activity keeps its source.
    const kind: WorkerKind = 'task'
    const harness = await this.host.harness()
    const agent = this.host.agent(activityId, kind)
    let session: HarnessSession
    let prompt = text
    try {
      session = await harness.resumeSession(workerSessionId(activityId), { agent, permission: this.host.permission() })
    } catch {
      // Its session is gone (or never existed: activities from before workers had their own).
      // Start over in a fresh one, seeded with what the user saw it produce.
      session = await harness.createSession({ id: workerSessionId(activityId), agent, title: activity.title, permission: this.host.permission() })
      prompt = `Earlier you worked on "${activity.title}". What came of it:\n${activity.report ?? activity.summary}\n\nNow: ${text}`
    }
    const run = this.attach(session, activity, kind, false, true)
    run.projector.reopen()
    run.projector.note(text)
    run.done = this.drive(activityId, run, prompt)
    return 'continued'
  }

  async stop(activityId: string): Promise<boolean> {
    const run = this.runs.get(activityId)
    if (!run || run.end !== undefined) return false
    run.end = 'stopped'
    run.session.cancel()
    return true
  }

  /** Every live worker, stopped — the app is going away. */
  async closeAll(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.stop(id)
    await Promise.allSettled([...this.runs.values()].flatMap((r) => (r.done ? [r.done] : [])))
  }

  private attach(session: HarnessSession, activity: Activity, kind: WorkerKind, unattended: boolean, visible: boolean): Run {
    const run: Run = {
      kind,
      unattended,
      visible,
      session,
      projector: new ActivityProjector(
        activity,
        (a) => {
          if (run.visible) this.host.activity(a)
        },
        this.newId,
        this.now,
      ),
    }
    this.runs.set(activity.id, run)
    session.onEvent((event) => {
      try {
        run.projector.handle(event)
      } catch (error) {
        console.error('[assistant] failed to project worker event', event.type, error)
      }
    })
    session.setApprovalHandler(this.host.approvalHandler(activity.id))
    return run
  }

  private async drive(activityId: string, run: Run, prompt: string): Promise<WorkerOutcome> {
    const timer = setTimeout(() => {
      if (run.end !== undefined) return
      run.end = 'timed_out'
      run.session.cancel()
    }, TIMEOUT_MS)
    let status: string | undefined
    let error: string | undefined
    try {
      status = (await run.session.prompt(prompt)).status
      // A message steered in as the turn was ending starts one more; let those finish too.
      for (let i = 0; i < 20 && run.end === undefined; i++) {
        const s = run.session.status
        if (s.state !== 'running' && !s.hasQueuedMessages) break
        await run.session.whenIdle()
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
    if (run.end === undefined) {
      if (error) run.end = 'failed'
      else if (status === 'aborted') run.end = 'stopped'
      else if (status === 'completed' || status === 'max_turns') run.end = 'completed'
      else run.end = 'failed'
    }
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
    await run.session.close().catch((e: unknown) => console.warn('[assistant] closing a worker session failed:', e))
    if (this.runs.get(activityId) === run) this.runs.delete(activityId)
    try {
      this.host.settled(outcome)
    } catch (e) {
      console.error('[assistant] handling a finished worker failed:', e)
    }
    return outcome
  }
}
