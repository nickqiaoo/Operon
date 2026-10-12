import { describe, expect, it } from 'vitest'
import { readUIMessageStream, type UIMessage } from 'ai'
import { createRuntime } from './index.js'
import { codex } from './codex.js'
import { claudeCode } from './claude-code.js'
import { toUIMessageStream } from './ai-sdk/index.js'
import { fakeAgent, FakeRuntimeProvider } from './testing.js'
import type { RuntimeStreamPart } from './types.js'

describe('createRuntime', () => {
  it('runs a turn end to end through the public API', async () => {
    FakeRuntimeProvider.resetScripts()
    const runtime = createRuntime({ providers: [fakeAgent()] })
    expect(runtime.providers().map((provider) => provider.id)).toEqual(['fake'])

    const session = await runtime.createSession('fake', { cwd: '/tmp', mode: 'plan' })
    const parts: RuntimeStreamPart[] = []
    for await (const part of session.send('hello')) parts.push(part)

    expect(parts.map((part) => part.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish'])
    expect(session.state?.()).toEqual({ currentModelId: 'fake-1', currentModeId: 'plan' })
    await session.close()
    await runtime.dispose()
  })

  it('turns a session stream into a UI message', async () => {
    FakeRuntimeProvider.resetScripts()
    const runtime = createRuntime({ providers: [fakeAgent()] })
    const session = await runtime.createSession('fake', { cwd: '/tmp' })

    let message: UIMessage | undefined
    for await (const next of readUIMessageStream({
      stream: toUIMessageStream(session.send('hello'), { messageId: 'm1' }),
    })) {
      message = next
    }
    expect(message?.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello from fake runtime.' }))
  })

  it('rejects a provider registered twice and an unknown id', () => {
    expect(() => createRuntime({ providers: [fakeAgent(), fakeAgent()] })).toThrow(/registered twice/)
    const runtime = createRuntime({ providers: [fakeAgent()] })
    expect(() => runtime.provider('nope')).toThrow(/No runtime provider registered/)
  })

  it('narrows options and natives to the provider picked by id', () => {
    const runtime = createRuntime({ providers: [claudeCode(), codex()] })
    // Type-level only: each call below is checked by `tsc`, never awaited.
    const typed = () => {
      void runtime.createSession('claude-code', { cwd: '/tmp', mode: 'acceptEdits', effort: 'max' })
      void runtime.createSession('codex', { cwd: '/tmp', mode: 'approveForMe', codex: { sandbox: 'read-only' } })
      // @ts-expect-error — a Claude Code mode is not a Codex mode
      void runtime.createSession('codex', { cwd: '/tmp', mode: 'acceptEdits' })
      // @ts-expect-error — Codex's knobs are not Claude Code options
      void runtime.createSession('claude-code', { cwd: '/tmp', codex: { sandbox: 'read-only' } })
      // @ts-expect-error — not a registered provider
      void runtime.createSession('gemini', { cwd: '/tmp' })
      void runtime.native('claude-code').peekAccountUsage()
      void runtime.native('codex').accountUsage(0)
    }
    expect(typeof typed).toBe('function')
  })
})
