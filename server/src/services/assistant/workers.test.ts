import type { PermissionDecision, RuntimeSession, RuntimeStreamPart } from '@operon/agent-runtime'
import { describe, expect, it } from 'vitest'
import type { Activity } from '../../../../shared/assistant.js'
import type { OpenParams } from './agents.js'
import { WorkerPool, type WorkerAgent, type WorkerKind, type WorkerOutcome, type WorkerPoolHost, type WorkerSessionRef } from './workers.js'

type Part = Record<string, unknown>

/** One scripted turn: the parts it streams, optionally after `gate` opens. */
interface Script {
  parts: Part[]
  gate?: Promise<void>
  /** Called once the turn has started streaming (to hand in a result, say). */
  onStart?: () => void
}

function reply(text: string, extra: Part[] = []): Part[] {
  return [
    { type: 'start' },
    { type: 'start-step' },
    ...extra,
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', text },
    { type: 'text-end', id: 't' },
    { type: 'finish-step', finishReason: 'stop', usage: {} },
    { type: 'finish', finishReason: 'stop', totalUsage: {} },
  ]
}

class FakeSession implements RuntimeSession {
  readonly prompts: string[] = []
  readonly injected: string[] = []
  disposed = false
  private abortTurn: (() => void) | undefined

  constructor(
    readonly params: OpenParams,
    private readonly scripts: Script[],
    private readonly id = `agent-${params.caller.id}`,
  ) {}

  stream(params: { messages: Array<{ content: unknown }> }): AsyncIterable<RuntimeStreamPart> {
    const content = params.messages.at(-1)?.content
    this.prompts.push(typeof content === 'string' ? content : JSON.stringify(content))
    const script = this.scripts.shift() ?? { parts: reply('ok') }
    const self = this
    return (async function* () {
      let aborted = false
      const stopped = new Promise<void>((resolve) => {
        self.abortTurn = () => {
          aborted = true
          resolve()
        }
      })
      script.onStart?.()
      if (script.gate) await Promise.race([script.gate, stopped])
      if (aborted) return
      for (const part of script.parts) yield part as unknown as RuntimeStreamPart
    })()
  }

  abort(): void {
    this.abortTurn?.()
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  resolvePermission(): boolean {
    return true
  }

  getSessionId(): string {
    return this.id
  }

  async injectMessage(content: string): Promise<void> {
    this.injected.push(content)
  }
}

function setup(options: { scripts?: Script[]; refs?: Record<string, WorkerSessionRef>; agent?: WorkerAgent } = {}) {
  const published: Activity[] = []
  const stored = new Map<string, Activity>()
  const opened: FakeSession[] = []
  const settled: WorkerOutcome[] = []
  const refs: Record<string, WorkerSessionRef> = { ...(options.refs ?? {}) }
  const scripts = options.scripts ?? []
  let n = 0
  const host: WorkerPoolHost = {
    agentFor: async (_kind: WorkerKind) => options.agent ?? { providerId: 'codex', modelId: 'gpt-x' },
    instructions: (kind, unattended) => `instructions:${kind}:${unattended}`,
    cwd: '/work',
    nodeRepl: () => false,
    open: async (params) => {
      const session = new FakeSession(params, scripts)
      opened.push(session)
      return session
    },
    activity: (a) => {
      published.push(a)
      stored.set(a.id, a)
    },
    stored: (id) => stored.get(id),
    approve: async (): Promise<PermissionDecision> => ({ type: 'allow' }),
    saveSession: (id, ref) => {
      refs[id] = ref
    },
    loadSession: (id) => refs[id],
    settled: (outcome) => {
      settled.push(outcome)
      stored.set(outcome.activity.id, outcome.activity)
    },
  }
  const pool = new WorkerPool(host, () => `w${++n}`, () => 100)
  return { pool, published, stored, opened, settled, refs }
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

describe('WorkerPool', () => {
  it('runs a task in a session of its own, on the agent picked for workers, and reports how it ended', async () => {
    const env = setup()
    const { id, done } = await env.pool.start({ kind: 'task', title: 'List files', prompt: 'list them', unattended: false, visible: true })
    env.pool.finish(id, { title: 'Listed files', summary: 'two of them', status: 'done' })
    const outcome = await done
    const session = env.opened[0]!
    expect(session.params).toMatchObject({ providerId: 'codex', modelId: 'gpt-x', kind: 'worker', caller: { role: 'worker', id }, cwd: '/work', instructions: 'instructions:task:false' })
    expect(session.prompts).toEqual(['list them'])
    expect(outcome).toMatchObject({ end: 'completed', kind: 'task', finalText: 'ok', activity: { status: 'done', title: 'Listed files', summary: 'two of them' } })
    expect(session.disposed).toBe(true)
    expect(env.refs[id]).toEqual({ providerId: 'codex', modelId: 'gpt-x', sessionId: `agent-${id}` })
    expect(env.settled).toHaveLength(1)
  })

  it('stops a running worker', async () => {
    const g = gate()
    const env = setup({ scripts: [{ parts: reply('never'), gate: g.promise }] })
    const { id, done } = await env.pool.start({ kind: 'task', title: 'Slow', prompt: 'go', unattended: false, visible: true })
    expect(await env.pool.stop(id)).toBe(true)
    const outcome = await done
    expect(outcome.end).toBe('stopped')
    expect(outcome.activity.status).toBe('stopped')
    expect(await env.pool.stop(id)).toBe(false)
  })

  it('folds a message into a running worker', async () => {
    const g = gate()
    const env = setup({ scripts: [{ parts: reply('done'), gate: g.promise }] })
    const { id, done } = await env.pool.start({ kind: 'task', title: 'Slow', prompt: 'go', unattended: false, visible: true })
    expect(await env.pool.continue(id, 'also the .md files')).toBe('delivered')
    g.open()
    await done
    expect(env.opened[0]!.injected).toEqual(['also the .md files'])
    expect(env.published.at(-1)!.steps.map((s) => s.label)).toContain('You: also the .md files')
  })

  it('picks a finished worker back up on the same agent session, with what it already did', async () => {
    const env = setup()
    const { id, done } = await env.pool.start({ kind: 'task', title: 'Count', prompt: 'count', unattended: false, visible: true })
    await done
    expect(await env.pool.continue(id, 'now divide by 7')).toBe('continued')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const resumed = env.opened[1]!
    expect(resumed.params).toMatchObject({ providerId: 'codex', modelId: 'gpt-x', sessionId: `agent-${id}`, kind: 'worker' })
    expect(resumed.prompts).toEqual(['now divide by 7'])
  })

  it('keeps the agent a task ran on when it is continued, even after Settings changed', async () => {
    const env = setup({ refs: {}, agent: { providerId: 'claude-code', modelId: '' } })
    const { id, done } = await env.pool.start({ kind: 'task', title: 'Count', prompt: 'count', unattended: false, visible: true })
    await done
    env.refs[id] = { providerId: 'opencode', modelId: 'm', sessionId: 'oc-1' }
    await env.pool.continue(id, 'again')
    expect(env.opened[1]!.params).toMatchObject({ providerId: 'opencode', modelId: 'm', sessionId: 'oc-1' })
  })

  it('starts over, seeded with the old result, when no session is left to resume', async () => {
    const env = setup()
    const activity: Activity = { id: 'old', taskId: 'aw-old', title: 'Old task', summary: 'it was 42', status: 'done', startedAt: 1, steps: [], report: 'it was 42' }
    env.stored.set('old', activity)
    expect(await env.pool.continue('old', 'add one')).toBe('continued')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const session = env.opened[0]!
    expect(session.params.sessionId).toBeUndefined()
    expect(session.prompts[0]).toContain('Earlier you worked on "Old task"')
    expect(session.prompts[0]).toContain('Now: add one')
  })

  it("keeps the user's words per worker, across follow-ups and a pick-up", async () => {
    const g = gate()
    const env = setup({ scripts: [{ parts: reply('done'), gate: g.promise }] })
    const { id, done } = await env.pool.start({ kind: 'task', title: 'T', prompt: 'p', unattended: false, visible: true, asked: 'check example.com' })
    await env.pool.continue(id, 'and docs too', 'look at docs.example.com as well')
    g.open()
    await done
    expect(env.pool.askedFor(id)).toBe('check example.com\nlook at docs.example.com as well')
  })

  it('says a task it never had is missing', async () => {
    const env = setup()
    expect(await env.pool.continue('nope', 'hi')).toBe('missing')
  })

  it('keeps a hidden run out of the activity list, and opens unattended runs as such', async () => {
    const env = setup()
    const { id, done } = await env.pool.start({ kind: 'heartbeat', title: 'Heartbeat', prompt: 'check', unattended: true, visible: false })
    expect(env.pool.isUnattended(id)).toBe(true)
    await done
    expect(env.published).toEqual([])
    expect(env.opened[0]!.params).toMatchObject({ kind: 'unattended', instructions: 'instructions:heartbeat:true' })
  })

  it('takes a result only from the kind of run that hands it in', async () => {
    const env = setup({ scripts: [{ parts: reply('a') }, { parts: reply('b') }] })
    const task = await env.pool.start({ kind: 'task', title: 'T', prompt: 'p', unattended: false, visible: true })
    const beat = await env.pool.start({ kind: 'heartbeat', title: 'H', prompt: 'p', unattended: true, visible: false })
    expect(env.pool.heartbeatDone(task.id, { findings: [] })).toBe(false)
    expect(env.pool.finish(beat.id, { title: 'x', summary: 'y', status: 'done' })).toBe(false)
    expect(env.pool.heartbeatDone(beat.id, { findings: [{ text: 'Bank alert', urgent: true }] })).toBe(true)
    expect((await beat.done).finish).toEqual({ tool: 'heartbeat_done', args: { findings: [{ text: 'Bank alert', urgent: true }] } })
    await task.done
  })

  it('fails a run whose turn failed, and passes the error on', async () => {
    const env = setup({ scripts: [{ parts: [{ type: 'start' }, { type: 'error', error: '500 {"error":{"message":"upstream down"}}' }] }] })
    const { done } = await env.pool.start({ kind: 'task', title: 'T', prompt: 'p', unattended: false, visible: true })
    const outcome = await done
    expect(outcome.end).toBe('failed')
    expect(outcome.activity).toMatchObject({ status: 'failed', summary: '500 · upstream down' })
    expect(outcome.error).toBe('500 · upstream down')
  })

  it('shows a reported milestone on the running activity', async () => {
    const g = gate()
    const env = setup({ scripts: [{ parts: reply('done'), gate: g.promise }] })
    const { id, done } = await env.pool.start({ kind: 'task', title: 'T', prompt: 'p', unattended: false, visible: true })
    expect(env.pool.progress(id, 'Found the page')).toBe(true)
    g.open()
    await done
    expect(env.pool.progress(id, 'late')).toBe(false)
    expect(env.published.at(-1)!.steps.map((s) => s.label)).toContain('Found the page')
  })
})
