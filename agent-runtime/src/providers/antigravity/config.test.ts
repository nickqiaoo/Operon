import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_CONFIG, ANTIGRAVITY_DEFAULT_MODEL_ID } from './config.js'
import type { AcpDiscoveryContext } from '../acp/index.js'

/** The shape Antigravity actually returns from `session/new`, trimmed. */
const sessionCtx = (models: Array<{ modelId: string; name?: string }>, current?: string) =>
  ({
    initialize: null,
    commands: null,
    session: { sessionId: 's1', models: { availableModels: models, currentModelId: current } },
  }) as unknown as AcpDiscoveryContext

describe('ANTIGRAVITY_CONFIG.extractModels', () => {
  it('reads the model list off session/new, not initialize', () => {
    const { models } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([
        { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
        { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      ]),
    )

    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'claude-opus-4-6-thinking'])
    expect(models[0].providerId).toBe('antigravity')
  })

  it('honours the caller’s model when the agent still offers it', () => {
    const { currentModelId } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([{ modelId: 'a' }, { modelId: 'b' }], 'a'),
      'b',
    )
    expect(currentModelId).toBe('b')
  })

  it('falls back to the agent’s own current model when the preference is gone', () => {
    const { currentModelId } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([{ modelId: 'a' }, { modelId: 'b' }], 'a'),
      'retired-model',
    )
    expect(currentModelId).toBe('a')
  })

  it('uses the agent\u2019s advertised current model over our static default', () => {
    // The shared ACP session only calls setSessionModel when the selection
    // differs from `defaultModelId`, so if these disagree operon shows one
    // model while the agent runs another.
    const { currentModelId } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([{ modelId: 'gemini-3.8-flash-high' }, { modelId: ANTIGRAVITY_DEFAULT_MODEL_ID }], ANTIGRAVITY_DEFAULT_MODEL_ID),
    )
    expect(currentModelId).toBe(ANTIGRAVITY_DEFAULT_MODEL_ID)
  })

  it('never keeps a preferred id the agent does not advertise', () => {
    // `gemini-3.1-pro-high` is what `agy models` calls it; over ACP that model
    // is `gemini-pro-agent`, so the CLI id names nothing and must be dropped.
    const { currentModelId } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([{ modelId: 'gemini-pro-agent' }, { modelId: 'gemini-3.7-flash-high' }], 'gemini-3.7-flash-high'),
      'gemini-3.1-pro-high',
    )
    expect(currentModelId).toBe('gemini-3.7-flash-high')
  })

  it('prefers our default over the first entry when the agent names none', () => {
    const { currentModelId } = ANTIGRAVITY_CONFIG.extractModels(
      sessionCtx([{ modelId: 'gemini-3.8-flash-low' }, { modelId: ANTIGRAVITY_DEFAULT_MODEL_ID }]),
    )
    expect(currentModelId).toBe(ANTIGRAVITY_DEFAULT_MODEL_ID)
  })

  it('serves a static model when the probe came back empty', () => {
    // A failed probe (agent not installed, not signed in) must still yield a
    // usable descriptor rather than an empty model picker.
    const { models, currentModelId } = ANTIGRAVITY_CONFIG.extractModels({
      initialize: null,
      session: null,
      commands: null,
    })
    expect(models).toHaveLength(1)
    expect(currentModelId).toBe(ANTIGRAVITY_DEFAULT_MODEL_ID)
  })
})

describe('ANTIGRAVITY_CONFIG.patchEnv', () => {
  const patch = (env: Record<string, string>) => ANTIGRAVITY_CONFIG.patchEnv!(env)

  it('never overrides a proxy the user configured themselves', () => {
    // Whatever they set is deliberate — including a SOCKS one they know works.
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      const env = { [key]: 'socks5://127.0.0.1:1080', PATH: '/usr/bin' }
      expect(patch(env)).toEqual(env)
    }
  })

  it('leaves the environment alone when there is no system SOCKS proxy to dodge', () => {
    // On CI (and any machine without a system SOCKS proxy) this is a no-op —
    // the patch exists only to stop Python resolving to a SOCKS proxy it cannot
    // speak without `python-socks`.
    const env = { PATH: '/usr/bin' }
    const patched = patch(env)
    // Either untouched, or an http:// proxy was substituted — never socks.
    expect(patched.HTTP_PROXY ?? 'http://').toMatch(/^http:\/\//)
    expect(patched.HTTPS_PROXY ?? 'http://').toMatch(/^http:\/\//)
    expect(patched.PATH).toBe('/usr/bin')
  })
})

describe('ANTIGRAVITY_CONFIG shape', () => {
  it('spawns the binary with no subcommand', () => {
    // `agy_acp_server` IS the agent; unlike grok ('agent stdio') or cursor
    // ('acp') there is no subcommand to select an ACP mode.
    expect(ANTIGRAVITY_CONFIG.agentArgs).toEqual([])
  })

  it('has no fallbackCommand, so a missing install shows as unavailable', () => {
    // The binary is a ~765MB manual download that never lands on PATH; guessing
    // a command name would spawn something that isn't there.
    expect(ANTIGRAVITY_CONFIG.fallbackCommand).toBeUndefined()
  })

  it('probes a session, because models are only advertised there', () => {
    expect(ANTIGRAVITY_CONFIG.modelProbe).toBe('session')
  })

  it('exposes the three modes the agent advertises', () => {
    expect(ANTIGRAVITY_CONFIG.modes.map((m) => m.id)).toEqual(['default', 'auto_edit', 'yolo'])
    expect(ANTIGRAVITY_CONFIG.defaultModeId).toBe('default')
  })
})

describe('ANTIGRAVITY_CONFIG usage reporting', () => {
  it('reports no usage, because the agent sends none', () => {
    // The agent sends no usage over ACP (measured: no `_meta` anywhere). The
    // figures exist in its debug log, but scraping that was declined — see the
    // note in config.ts. A fabricated 0 reads as a broken badge.
    expect(ANTIGRAVITY_CONFIG.parseUsage).toBeUndefined()
    expect(ANTIGRAVITY_CONFIG.parseContextTokens).toBeUndefined()
  })
})
