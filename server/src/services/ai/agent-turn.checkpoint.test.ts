import { describe, expect, it } from 'vitest'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { AgentSession, RuntimeStreamPart } from '@operon/agent-runtime'
import { runAgentTurn } from './agent-turn.js'

const part = (value: Record<string, unknown>): RuntimeStreamPart => value as unknown as RuntimeStreamPart

/** A provider turn: some text, then a tool call that runs until `release()`, then more text. */
function sessionWithSlowTool(): { session: AgentSession; release: () => void } {
  let release!: () => void
  const toolDone = new Promise<void>((resolve) => {
    release = resolve
  })
  const session: AgentSession = {
    id: undefined,
    async *send(): AsyncIterable<RuntimeStreamPart> {
      yield part({ type: 'start' })
      yield part({ type: 'start-step', request: {}, warnings: [] })
      yield part({ type: 'text-start', id: 't1' })
      for (const text of ['Let me ', 'look.']) yield part({ type: 'text-delta', id: 't1', text })
      yield part({ type: 'text-end', id: 't1' })
      yield part({ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { cmd: 'make' }, dynamic: true })
      await toolDone
      yield part({ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', input: { cmd: 'make' }, output: 'ok', dynamic: true })
      yield part({ type: 'text-start', id: 't2' })
      yield part({ type: 'text-delta', id: 't2', text: 'Built.' })
      yield part({ type: 'text-end', id: 't2' })
      yield part({
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
        providerMetadata: undefined,
      })
      yield part({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    },
    abort() {},
    async close() {},
    respond: () => false,
  }
  return { session, release }
}

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const toolStates = (message: UIMessage): string[] =>
  message.parts.filter((p) => p.type === 'dynamic-tool').map((p) => (p as { state: string }).state)

describe('runAgentTurn checkpoints', () => {
  it('hands over the reply while a tool is still running', async () => {
    const { session, release } = sessionWithSlowTool()
    const checkpoints: UIMessage[] = []
    const turn = runAgentTurn(session, {
      requestId: 'r1',
      input: '',
      signal: new AbortController().signal,
      assistantMessageId: 'a1',
      originalMessages: [],
      onCheckpoint: (message) => {
        checkpoints.push(message)
      },
    })

    // The turn is parked inside the tool; the reply so far is already out,
    // tool call included (after the 1s pacing gap if the text came just before).
    await until(() => checkpoints.some((m) => toolStates(m).includes('input-available')))
    const parked = checkpoints[checkpoints.length - 1]!
    expect(parked.id).toBe('a1')
    expect(parked.parts.some((p) => p.type === 'text' && p.text === 'Let me look.')).toBe(true)

    release()
    const { message } = await turn.done
    expect(toolStates(message)).toEqual(['output-available'])
    expect(message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual([
      'Let me look.',
      'Built.',
    ])
    // A snapshot, not the live object the SDK keeps assembling.
    expect(toolStates(parked)).toEqual(['input-available'])
  })

  it('assembles the same final message as a turn without checkpoints', async () => {
    const run = async (withCheckpoints: boolean): Promise<UIMessage> => {
      const { session, release } = sessionWithSlowTool()
      release()
      const turn = runAgentTurn(session, {
        requestId: 'r',
        input: '',
        signal: new AbortController().signal,
        assistantMessageId: 'a',
        originalMessages: [],
        ...(withCheckpoints ? { onCheckpoint: () => undefined } : {}),
      })
      const { message } = await turn.done
      // The turn's wall-clock bounds differ between the two runs.
      const { turnStartedAt: _start, turnEndedAt: _end, ...metadata } = (message.metadata ?? {}) as Record<string, unknown>
      return { ...message, metadata }
    }
    expect(await run(true)).toEqual(await run(false))
  })
})

describe('runAgentTurn drives itself', () => {
  it('finishes with nobody observing it', async () => {
    const { session, release } = sessionWithSlowTool()
    release()
    const { message, error } = await runAgentTurn(session, {
      requestId: 'r',
      input: '',
      signal: new AbortController().signal,
      assistantMessageId: 'a',
      originalMessages: [],
    }).done
    expect(error).toBeUndefined()
    expect(toolStates(message)).toEqual(['output-available'])
  })

  it('hands observers the chunks of the very reply it assembles, checkpoints included', async () => {
    const { session, release } = sessionWithSlowTool()
    release()
    const chunks: UIMessageChunk[] = []
    const turn = runAgentTurn(session, {
      requestId: 'r',
      input: '',
      signal: new AbortController().signal,
      assistantMessageId: 'a',
      originalMessages: [],
      onCheckpoint: () => undefined,
      onChunk: (chunk) => chunks.push(chunk),
    })
    const { message } = await turn.done
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    let rebuilt: UIMessage | undefined
    for await (const m of readUIMessageStream({ stream })) rebuilt = m
    expect(rebuilt).toEqual(message)
  })
})
