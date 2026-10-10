import { describe, expect, it } from 'vitest'
import type { Agent, AgentEvent, Harness, HarnessSession } from 'operon-agents'
import type { Activity } from '../../../../shared/assistant.js'
import { WorkerPool, workerOfSession, workerSessionId, type WorkerOutcome } from './workers.js'

type Body = Omit<AgentEvent, 'eventId' | 'sessionId'>

/** Just enough of a HarnessSession for the pool: prompts are settled by the test. */
class FakeSession {
  readonly prompts: string[] = []
  readonly steered: string[] = []
  cancelled = false
  closed = false
  private listeners: Array<(e: AgentEvent) => void> = []
  private finish: ((status: string) => void) | undefined
  status = { state: 'idle' as 'idle' | 'running', hasQueuedMessages: false, activeTurnId: null }

  constructor(readonly id: string) {}

  prompt(text: string): Promise<{ status: string }> {
    this.prompts.push(text)
    this.status.state = 'running'
    return new Promise((resolve) => {
      this.finish = (status) => {
        this.status.state = 'idle'
        resolve({ status })
      }
    })
  }
  end(status = 'completed'): void {
    this.finish?.(status)
  }
  steer(text: string): void {
    this.steered.push(text)
  }
  cancel(): void {
    this.cancelled = true
    this.end('aborted')
  }
  whenIdle(): Promise<void> {
    return Promise.resolve()
  }
  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  emit(...events: Body[]): void {
    for (const e of events) for (const l of this.listeners) l({ eventId: 'e', sessionId: this.id, ...e } as AgentEvent)
  }
  setApprovalHandler(): void {}
  async close(): Promise<void> {
    this.closed = true
  }
}

function setup() {
  const sessions = new Map<string, FakeSession>()
  const created: Array<{ id: string; resumed: boolean }> = []
  const published: Activity[] = []
  const stored = new Map<string, Activity>()
  const outcomes: WorkerOutcome[] = []
  let n = 0
  const harness = {
    createSession: async (opts: { id: string }) => {
      const s = new FakeSession(opts.id)
      sessions.set(opts.id, s)
      created.push({ id: opts.id, resumed: false })
      return s
    },
    resumeSession: async (id: string) => {
      if (!sessions.has(id)) throw new Error('no such session')
      const s = new FakeSession(id)
      sessions.set(id, s)
      created.push({ id, resumed: true })
      return s
    },
  }
  const pool = new WorkerPool(
    {
      harness: async () => harness as unknown as Harness,
      agent: () => ({}) as Agent,
      permission: () => undefined,
      activity: (a) => {
        published.push(a)
        stored.set(a.id, a)
      },
      stored: (id) => stored.get(id),
      approvalHandler: () => async () => ({ decision: 'approved' }),
      settled: (o) => outcomes.push(o),
    },
    () => `w${++n}`,
    () => 1_000,
  )
  const session = (activityId: string) => sessions.get(workerSessionId(activityId))!
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { pool, session, published, stored, outcomes, created, flush }
}

describe('worker sessions', () => {
  it('maps activity ids to session ids and back, and leaves other sessions alone', () => {
    expect(workerOfSession(workerSessionId('abc'))).toBe('abc')
    expect(workerOfSession('9f1c-main-session')).toBeUndefined()
  })
})

describe('WorkerPool', () => {
  it('runs a task in a session of its own and reports how it ended', async () => {
    const { pool, session, published, outcomes, flush } = setup()
    const { id, done } = await pool.start({ kind: 'task', title: '查天气', prompt: 'look it up', unattended: false, visible: true })
    expect(published[0]).toMatchObject({ id, taskId: `aw-${id}`, status: 'running', title: '查天气' })
    const s = session(id)
    expect(s.prompts).toEqual(['look it up'])
    s.emit(
      { type: 'tool.call.started', address: 'main', toolCallId: 'c1', toolName: 'Bash', args: { intent: '查一下', command: 'curl' } } as Body,
      { type: 'tool.result', address: 'main', toolCallId: 'c1', toolName: 'Bash', result: { content: [{ type: 'text', text: 'sunny' }] }, isError: false } as Body,
      { type: 'message.appended', address: 'main', message: { role: 'assistant', content: [{ type: 'text', text: '晴。' }] } } as Body,
      { type: 'tool.call.started', address: 'main', toolCallId: 'c2', toolName: 'finish_task', args: { title: '天气', summary: '晴', status: 'done' } } as Body,
    )
    expect(pool.isRunning(id)).toBe(true)
    s.end('completed')
    const outcome = await done
    await flush()
    expect(outcome).toMatchObject({ kind: 'task', end: 'completed', finalText: '晴。' })
    expect(published.at(-1)).toMatchObject({ status: 'done', title: '天气', summary: '晴' })
    expect(s.closed).toBe(true)
    expect(outcomes).toHaveLength(1)
    expect(pool.isRunning(id)).toBe(false)
  })

  it('stops a running worker', async () => {
    const { pool, session, published } = setup()
    const { id, done } = await pool.start({ kind: 'task', title: 't', prompt: 'p', unattended: false, visible: true })
    expect(await pool.stop(id)).toBe(true)
    expect(session(id).cancelled).toBe(true)
    expect((await done).end).toBe('stopped')
    expect(published.at(-1)!.status).toBe('stopped')
    expect(await pool.stop(id)).toBe(false)
  })

  it('folds a message into a running worker', async () => {
    const { pool, session, published } = setup()
    const { id } = await pool.start({ kind: 'task', title: 't', prompt: 'p', unattended: false, visible: true })
    expect(await pool.continue(id, '顺便查上海')).toBe('delivered')
    expect(session(id).steered).toEqual(['顺便查上海'])
    expect(published.at(-1)!.steps.at(-1)!.label).toBe('You: 顺便查上海')
  })

  it('picks a finished worker back up in its own session, with what it already did', async () => {
    const { pool, session, published, created } = setup()
    const { id, done } = await pool.start({ kind: 'task', title: 't', prompt: 'p', unattended: false, visible: true })
    session(id).end('completed')
    await done
    expect(await pool.continue(id, '再改一下')).toBe('continued')
    expect(created.at(-1)).toEqual({ id: `aw-${id}`, resumed: true })
    expect(session(id).prompts).toEqual(['再改一下'])
    expect(published.at(-1)).toMatchObject({ id, status: 'running' })
  })

  it('starts over, seeded with the old result, when the session is gone', async () => {
    const { pool, session, stored, created } = setup()
    stored.set('old', { id: 'old', taskId: 'agent-1', title: '旧任务', summary: '做了一半', report: '完整结果', status: 'done', startedAt: 1, steps: [] })
    expect(await pool.continue('old', '接着做')).toBe('continued')
    expect(created.at(-1)).toEqual({ id: 'aw-old', resumed: false })
    expect(session('old').prompts[0]).toContain('完整结果')
    expect(session('old').prompts[0]).toContain('接着做')
  })

  it("keeps the user's words per worker, across follow-ups and a pick-up", async () => {
    const { pool, session } = setup()
    const a = await pool.start({ kind: 'task', title: 'a', prompt: 'p', unattended: false, visible: true, asked: '看看 github.com 的通知' })
    const b = await pool.start({ kind: 'task', title: 'b', prompt: 'p', unattended: false, visible: true, asked: '查下天气' })
    expect(pool.askedFor(a.id)).toBe('看看 github.com 的通知')
    expect(pool.askedFor(b.id)).toBe('查下天气')
    await pool.continue(a.id, '顺便看 PR', '顺便看下 PR 列表')
    session(a.id).end('completed')
    await a.done
    await pool.continue(a.id, '再看 issues', '再看 issues')
    expect(pool.askedFor(a.id)).toBe('看看 github.com 的通知\n顺便看下 PR 列表\n再看 issues')
    expect(pool.askedFor(b.id)).toBe('查下天气')
    const heartbeat = await pool.start({ kind: 'heartbeat', title: 'Heartbeat', prompt: 'p', unattended: true, visible: false })
    expect(pool.askedFor(heartbeat.id)).toBe('')
  })

  it('says a task it never had is missing', async () => {
    const { pool } = setup()
    expect(await pool.continue('nope', 'x')).toBe('missing')
  })

  it('keeps a hidden run out of the activity list, and remembers who is unattended', async () => {
    const { pool, session, published } = setup()
    const { id, done } = await pool.start({ kind: 'heartbeat', title: 'Heartbeat', prompt: 'p', unattended: true, visible: false })
    expect(pool.isUnattended(id)).toBe(true)
    session(id).emit({ type: 'tool.call.started', address: 'main', toolCallId: 'c', toolName: 'Bash', args: { intent: '看邮件' } } as Body)
    session(id).end('completed')
    const outcome = await done
    expect(published).toEqual([])
    expect(outcome.activity).toMatchObject({ source: 'heartbeat', status: 'done' })
    expect(outcome.activity.steps).toHaveLength(1)
  })

  it('fails a run whose turn failed, and passes the error on', async () => {
    const { pool, session, published } = setup()
    const { id, done } = await pool.start({ kind: 'task', title: 't', prompt: 'p', unattended: false, visible: true })
    session(id).emit({ type: 'turn.ended', address: 'main', turnId: 't', reason: 'failed', error: '402 budget exhausted' } as Body)
    session(id).end('completed')
    expect(await done).toMatchObject({ end: 'completed', error: '402 budget exhausted' })
    expect(published.at(-1)).toMatchObject({ status: 'failed', summary: '402 budget exhausted' })
  })
})
