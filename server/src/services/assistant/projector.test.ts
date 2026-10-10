import { describe, expect, it } from 'vitest'
import type { AgentEvent } from 'operon-agents'
import type { Activity, AssistantMessage } from '../../../../shared/assistant.js'
import { ActivityProjector, AssistantProjector, briefError } from './projector.js'

type Body = Omit<AgentEvent, 'eventId' | 'sessionId'>

const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

function thread() {
  const messages: AssistantMessage[] = []
  const typing: boolean[] = []
  let n = 0
  const projector = new AssistantProjector(
    { message: (m) => messages.push(m), typing: (t) => typing.push(t) },
    () => `id-${++n}`,
    () => 1_000,
  )
  const feed = (...events: Body[]) => {
    for (const e of events) projector.handle({ eventId: `e${++n}`, sessionId: 's', ...e } as AgentEvent)
  }
  return { projector, feed, messages, typing }
}

const dispatchMessage = (text: string, callId = 'call-1') => ({
  role: 'assistant',
  content: [{ type: 'text', text }, { type: 'toolCall', id: callId, name: 'start_task', arguments: { title: '查苏州天气', prompt: '…' } }],
})

describe('AssistantProjector (the thread)', () => {
  it('holds a reply that also dispatches until the dispatch runs, then links it', () => {
    const { projector, feed, messages, typing } = thread()
    feed(
      { type: 'turn.started', address: 'main', turnId: 't1' } as Body,
      { type: 'message.appended', address: 'main', message: user('查下苏州天气') } as Body,
      { type: 'message.appended', address: 'main', message: dispatchMessage('好，我去查。') } as Body,
    )
    expect(messages).toEqual([])
    projector.dispatch('call-1', 'trip')
    expect(messages).toEqual([{ id: expect.any(String), role: 'assistant', text: '好，我去查。', createdAt: 1_000, activityId: 'trip' }])
    feed({ type: 'turn.ended', address: 'main', turnId: 't1', reason: 'completed' } as Body)
    expect(messages).toHaveLength(1)
    expect(typing).toEqual([true, false])
  })

  it('links an ack written after the dispatch to that worker', () => {
    const { projector, feed, messages } = thread()
    feed(
      { type: 'turn.started', address: 'main', turnId: 't1' } as Body,
      { type: 'message.appended', address: 'main', message: user('查天气') } as Body,
    )
    projector.dispatch('call-1', 'trip')
    feed({ type: 'message.appended', address: 'main', message: assistant('在查了。') } as Body)
    expect(messages[0]).toMatchObject({ text: '在查了。', activityId: 'trip' })
  })

  it('releases a held reply at turn end even if the dispatch never ran', () => {
    const { feed, messages } = thread()
    feed(
      { type: 'turn.started', address: 'main', turnId: 't1' } as Body,
      { type: 'message.appended', address: 'main', message: dispatchMessage('试试看', 'x') } as Body,
      { type: 'turn.ended', address: 'main', turnId: 't1', reason: 'completed' } as Body,
    )
    expect(messages.map((m) => m.text)).toEqual(['试试看'])
    expect(messages[0].activityId).toBeUndefined()
  })

  it('marks the reply to a finished-task notice as triggered by that worker', () => {
    const { feed, messages } = thread()
    feed(
      { type: 'turn.started', address: 'main', turnId: 't2' } as Body,
      {
        type: 'message.appended',
        address: 'main',
        message: user('[Task finished] …'),
        origin: { kind: 'external', source: 'worker-done', metadata: { activityId: 'trip' }, channel: 'follow_up' },
      } as Body,
      // Framework context injected mid-turn must not change why main is speaking.
      { type: 'message.appended', address: 'main', message: user('<system-reminder/>'), origin: { kind: 'injection', injectorId: 'skill_catalog' } } as Body,
      { type: 'message.appended', address: 'main', message: assistant('苏州在下小雨。') } as Body,
    )
    expect(messages.at(-1)).toMatchObject({ text: '苏州在下小雨。', trigger: { kind: 'worker', activityId: 'trip' }, activityId: 'trip' })
  })

  it('tags replies to the heartbeat and to a scheduled task', () => {
    const { feed, messages } = thread()
    feed(
      { type: 'message.appended', address: 'main', message: user('[Heartbeat] …'), origin: { kind: 'external', source: 'heartbeat', metadata: { activityId: 'hb' }, channel: 'follow_up' } } as Body,
      { type: 'message.appended', address: 'main', message: assistant('刚看到一封银行邮件。') } as Body,
      { type: 'message.appended', address: 'main', message: user('[Scheduled] …'), origin: { kind: 'external', source: 'schedule', metadata: { name: 'Morning brief', activityId: 'mb' }, channel: 'follow_up' } } as Body,
      { type: 'message.appended', address: 'main', message: assistant('早报来了。') } as Body,
    )
    expect(messages[0]).toMatchObject({ trigger: { kind: 'heartbeat' }, activityId: 'hb' })
    expect(messages[1]).toMatchObject({ trigger: { kind: 'schedule', name: 'Morning brief' }, activityId: 'mb' })
  })

  it('attaches remembered lines to the next main reply only', () => {
    const { projector, feed, messages } = thread()
    projector.remember('不喝咖啡，只喝茶')
    feed(
      { type: 'message.appended', address: 'main', message: user('记住我只喝茶') } as Body,
      { type: 'message.appended', address: 'main', message: assistant('记好了。') } as Body,
      { type: 'message.appended', address: 'main', message: assistant('还有别的吗？') } as Body,
    )
    expect(messages[0].remembered).toEqual(['不喝咖啡，只喝茶'])
    expect(messages[1].remembered).toBeUndefined()
  })

  it('puts a line saved after the reply onto that same reply', () => {
    const { projector, feed, messages } = thread()
    feed(
      { type: 'turn.started', address: 'main', turnId: 't1' } as Body,
      { type: 'message.appended', address: 'main', message: user('记住我只喝茶') } as Body,
      { type: 'message.appended', address: 'main', message: assistant('记下了。') } as Body,
    )
    projector.remember('只喝茶')
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ id: messages[0].id, text: '记下了。', remembered: ['只喝茶'] })
  })

  it('says something when a main turn fails', () => {
    const { feed, messages } = thread()
    feed({ type: 'turn.ended', address: 'main', turnId: 't', reason: 'failed', error: '401 invalid key' } as Body)
    expect(messages[0].text).toContain('401 invalid key')
  })
})

function worker(seed: Partial<Activity> = {}) {
  const published: Activity[] = []
  let n = 0
  const activity: Activity = { id: 'trip', taskId: 'aw-trip', title: '查苏州天气', summary: 'Working…', status: 'running', startedAt: 500, steps: [], ...seed }
  const projector = new ActivityProjector(activity, (a) => published.push(a), () => `id-${++n}`, () => 900)
  const feed = (...events: Body[]) => {
    for (const e of events) projector.handle({ eventId: `e${++n}`, sessionId: 'aw-trip', ...e } as AgentEvent)
  }
  const last = () => published.at(-1)!
  return { projector, feed, published, last }
}

/** The worker does two steps, the second fails. */
function twoSteps(feed: ReturnType<typeof worker>['feed']) {
  feed(
    { type: 'tool.call.started', address: 'main', toolCallId: 'c1', toolName: 'mcp__weather__get_weather', args: { intent: '查询苏州天气', city: 'suzhou' } } as Body,
    { type: 'tool.result', address: 'main', toolCallId: 'c1', toolName: 'mcp__weather__get_weather', result: { content: [{ type: 'text', text: 'suzhou: rain' }] }, isError: false } as Body,
    { type: 'tool.call.started', address: 'main', toolCallId: 'c2', toolName: 'Read', args: { intent: '读行程', path: 'notes.md' } } as Body,
    { type: 'tool.result', address: 'main', toolCallId: 'c2', toolName: 'Read', result: { content: [{ type: 'text', text: 'no such file' }] }, isError: true } as Body,
  )
}

describe('ActivityProjector (one worker)', () => {
  it('turns tool calls into plain-language steps', () => {
    const { feed, last } = worker()
    twoSteps(feed)
    const a = last()
    expect(a.steps.map((s) => [s.label, s.status, s.tool])).toEqual([
      ['查询苏州天气', 'done', 'mcp__weather__get_weather'],
      ['读行程', 'failed', 'Read'],
    ])
    expect(a.steps[0].args).toEqual({ city: 'suzhou' })
    expect(a.steps[0].result).toBe('suzhou: rain')
  })

  it('settles from finish_task, keeping the full result as the report', () => {
    const { projector, feed, last } = worker()
    twoSteps(feed)
    feed(
      { type: 'message.appended', address: 'main', message: assistant('苏州小雨，19°C。行程文件没找到。') } as Body,
      { type: 'tool.call.started', address: 'main', toolCallId: 'c3', toolName: 'finish_task', args: { title: '苏州天气', summary: '小雨 19°C', status: 'partial' } } as Body,
    )
    projector.settle('completed')
    expect(last()).toMatchObject({ status: 'partial', title: '苏州天气', summary: '小雨 19°C', finishedAt: 900 })
    expect(last().report).toContain('行程文件没找到')
    expect(last().steps).toHaveLength(2)
  })

  it('falls back to the final text when the worker never calls finish_task', () => {
    const { projector, feed, last } = worker()
    feed({ type: 'message.appended', address: 'main', message: assistant('## 结果如下：\n- **苏州**小雨，19°C') } as Body)
    projector.settle('completed')
    expect(last()).toMatchObject({ status: 'done', title: '查苏州天气', summary: '苏州小雨，19°C' })
  })

  it('marks a stopped worker and its unfinished steps', () => {
    const { projector, feed, last } = worker()
    feed({ type: 'tool.call.started', address: 'main', toolCallId: 'c4', toolName: 'Bash', args: { intent: '跑一下', command: 'sleep 9' } } as Body)
    projector.settle('stopped')
    expect(last()).toMatchObject({ status: 'stopped', summary: 'Stopped' })
    expect(last().steps.at(-1)!.status).toBe('failed')
  })

  it('fails a run whose turn failed, saying why', () => {
    const { projector, feed, last } = worker()
    feed({ type: 'turn.ended', address: 'main', turnId: 't', reason: 'failed', error: '402 budget exhausted' } as Body)
    projector.settle('completed')
    expect(last()).toMatchObject({ status: 'failed', summary: '402 budget exhausted' })
  })

  it('says so when a run ran out of time', () => {
    const { projector, last } = worker()
    projector.settle('timed_out')
    expect(last()).toMatchObject({ status: 'failed', summary: 'Took too long and was stopped' })
  })

  it('flips a live worker to waiting and back, and leaves a finished one alone', () => {
    const { projector, last } = worker()
    projector.setWaiting(true)
    expect(last().status).toBe('waiting')
    projector.setWaiting(false)
    expect(last().status).toBe('running')
    projector.settle('completed')
    projector.setWaiting(true)
    expect(last().status).toBe('done')
  })

  it('reopens the same activity when a finished task is continued, steps kept', () => {
    const { projector, feed, last } = worker()
    twoSteps(feed)
    projector.settle('completed')
    projector.reopen()
    projector.note('顺便查下上海')
    expect(last()).toMatchObject({ status: 'running', summary: 'Working…' })
    expect(last().finishedAt).toBeUndefined()
    expect(last().steps.map((s) => s.label)).toEqual(['查询苏州天气', '读行程', 'You: 顺便查下上海'])
  })

  it('ignores events from anywhere but the worker itself', () => {
    const { feed, published } = worker()
    feed({ type: 'tool.call.started', address: 'main/helper', toolCallId: 'x', toolName: 'Bash', args: { intent: 'nested' } } as Body)
    expect(published).toEqual([])
  })

  it("takes a failed model call's own error, not \"unknown error\"", () => {
    const { projector, feed, last } = worker()
    const body = '402 {"type":"error","error":{"type":"billing_error","message":"This request requires more credits, or fewer max_tokens."}}'
    feed(
      { type: 'message.appended', address: 'main', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: body } } as Body,
      { type: 'turn.ended', address: 'main', turnId: 't', reason: 'failed' } as Body,
    )
    projector.settle('completed')
    expect(last()).toMatchObject({ status: 'failed', summary: '402 · This request requires more credits, or fewer max_tokens.' })
  })
})

describe('briefError', () => {
  it('keeps plain errors and boils JSON bodies down to status and message', () => {
    expect(briefError('fetch failed')).toBe('fetch failed')
    expect(briefError('429 {"error":{"message":"Rate limited"}}')).toBe('429 · Rate limited')
  })
})
