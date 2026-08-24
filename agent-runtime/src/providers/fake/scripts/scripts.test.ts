import { describe, it, expect } from 'vitest'
import type { FakeScript, FakeScriptCtx, FakeSessionState } from '../index.js'
import type { RuntimeStreamPart } from '../../../types.js'
import { BUILTIN_SCRIPT_NAMES, installBuiltinScripts } from './index.js'
import { FakeRuntimeProvider } from '../index.js'

installBuiltinScripts()

function makeCtx(overrides: Partial<FakeSessionState> = {}): FakeScriptCtx {
  const session: FakeSessionState = {
    userMessage: 'hello',
    turnIndex: 0,
    aborted: false,
    waitForPermission: async () => ({ type: 'allow' }),
    throwIfAborted: () => {},
    ...overrides,
  }
  return {
    params: { requestId: 'r-test', messages: [] },
    session,
    delay: async () => {},
  }
}

async function collect(script: FakeScript, ctx: FakeScriptCtx): Promise<RuntimeStreamPart[]> {
  const parts: RuntimeStreamPart[] = []
  for await (const p of script(ctx)) parts.push(p)
  return parts
}

describe('fake script registry', () => {
  it('installs every documented built-in script', () => {
    for (const name of BUILTIN_SCRIPT_NAMES) {
      expect(FakeRuntimeProvider.scripts.has(name), `script ${name} not registered`).toBe(true)
    }
  })

  it('registry survives resetScripts()', () => {
    FakeRuntimeProvider.resetScripts()
    for (const name of BUILTIN_SCRIPT_NAMES) {
      expect(FakeRuntimeProvider.scripts.has(name)).toBe(true)
    }
  })
})

const STYLES = ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'custom'] as const

describe.each(STYLES)('%s-style scripts', (style) => {
  it(`${style}-text-only emits start, text-*, finish`, async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get(`${style}-text-only`)!,
      makeCtx(),
    )
    const types = parts.map((p) => p.type)
    expect(types).toContain('text-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types).toContain('finish')
  })

  it(`${style}-tool-call emits the tool-call sequence`, async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get(`${style}-tool-call`)!,
      makeCtx(),
    )
    const types = parts.map((p) => p.type)
    expect(types).toContain('tool-input-start')
    expect(types).toContain('tool-input-delta')
    expect(types).toContain('tool-input-end')
    expect(types).toContain('tool-call')
    expect(types).toContain('tool-result')
    expect(types).toContain('finish')

    // Order: input-start before tool-call, tool-call before tool-result
    const toolCallIdx = types.indexOf('tool-call')
    const inputStartIdx = types.indexOf('tool-input-start')
    const toolResultIdx = types.indexOf('tool-result')
    expect(inputStartIdx).toBeLessThan(toolCallIdx)
    expect(toolCallIdx).toBeLessThan(toolResultIdx)
  })

  it(`${style}-permission requests approval and waits for the decision`, async () => {
    let resolveDecision: ((decision: { type: 'allow' }) => void) | null = null
    const ctx = makeCtx({
      waitForPermission: () =>
        new Promise((resolve) => {
          resolveDecision = resolve
        }),
    })
    const iter = FakeRuntimeProvider.scripts.get(`${style}-permission`)!(ctx)[Symbol.asyncIterator]()

    // Drain until we see the approval request.
    let sawApproval = false
    while (true) {
      const result = await iter.next()
      if (result.done) {
        expect.fail(`${style}-permission ended without a tool-approval-request`)
      }
      if (result.value.type === 'tool-approval-request') {
        sawApproval = true
        break
      }
    }
    expect(sawApproval).toBe(true)

    // Pump the iterator one step so the script reaches `await waitForPermission`.
    // This call returns once the script either yields again or suspends inside
    // the awaited promise — the polling loop below resolves the promise as soon
    // as it is registered.
    const continuation = iter.next()
    while (!resolveDecision) {
      await new Promise((r) => setImmediate(r))
    }
    ;(resolveDecision as (d: { type: 'allow' }) => void)({ type: 'allow' })
    await continuation

    // Drain to completion.
    const remaining: RuntimeStreamPart[] = []
    while (true) {
      const result = await iter.next()
      if (result.done) break
      remaining.push(result.value)
    }
    expect(remaining.some((p) => p.type === 'finish')).toBe(true)
  })

  it(`${style}-permission emits tool-error on deny`, async () => {
    const ctx = makeCtx({
      waitForPermission: async () => ({ type: 'deny', reason: 'user said no' }),
    })
    const parts = await collect(
      FakeRuntimeProvider.scripts.get(`${style}-permission`)!,
      ctx,
    )
    const errOrDenied = parts.find(
      (p) => p.type === 'tool-error' || p.type === 'tool-output-denied',
    )
    expect(errOrDenied).toBeDefined()
    expect(parts[parts.length - 1]?.type).toBe('finish')
  })

  it(`${style}-reasoning emits reasoning-* events`, async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get(`${style}-reasoning`)!,
      makeCtx(),
    )
    const types = parts.map((p) => p.type)
    expect(types).toContain('reasoning-start')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('reasoning-end')
    expect(types).toContain('finish')
  })

  it(`${style}-error emits an error event with finishReason error`, async () => {
    const parts = await collect(FakeRuntimeProvider.scripts.get(`${style}-error`)!, makeCtx())
    expect(parts.some((p) => p.type === 'error')).toBe(true)
    const finish = parts.find((p) => p.type === 'finish') as
      | Extract<RuntimeStreamPart, { type: 'finish' }>
      | undefined
    expect(finish?.finishReason).toBe('error')
  })

  it(`${style}-multi-turn includes the user message`, async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get(`${style}-multi-turn`)!,
      makeCtx({ userMessage: 'ping', turnIndex: 2 }),
    )
    const text = parts
      .filter((p): p is Extract<RuntimeStreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('')
    expect(text).toContain('ping')
  })
})

describe('basics scripts', () => {
  it('echo reflects the user message', async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get('echo')!,
      makeCtx({ userMessage: 'beep' }),
    )
    const text = parts
      .filter((p): p is Extract<RuntimeStreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('')
    expect(text).toContain('beep')
  })

  it('split-text emits at least two deltas', async () => {
    const parts = await collect(
      FakeRuntimeProvider.scripts.get('split-text')!,
      makeCtx(),
    )
    const deltas = parts.filter((p) => p.type === 'text-delta')
    expect(deltas.length).toBeGreaterThanOrEqual(2)
  })
})
