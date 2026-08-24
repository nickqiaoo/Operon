import { describe, expect, it } from 'vitest'
import { GROK_CONFIG } from './config.js'

describe('GROK_CONFIG.parseUsage', () => {
  // The real `_meta` shape captured from a grok ACP `prompt` response.
  const promptMeta = {
    sessionId: 'abc',
    totalTokens: 16035,
    inputTokens: 16006,
    outputTokens: 28,
    cachedReadTokens: 11264,
    reasoningTokens: 23,
    usage: {
      inputTokens: 16006,
      outputTokens: 28,
      totalTokens: 16034,
      cachedReadTokens: 11264,
      reasoningTokens: 23,
      modelCalls: 1,
      numTurns: 1,
    },
  }

  it('maps the nested usage object onto the AI-SDK usage shape', () => {
    const usage = GROK_CONFIG.parseUsage?.(promptMeta)
    expect(usage).toBeDefined()
    expect(usage?.inputTokens).toBe(16006)
    expect(usage?.outputTokens).toBe(28)
    expect(usage?.totalTokens).toBe(16034)
    expect(usage?.cachedInputTokens).toBe(11264)
    expect(usage?.inputTokenDetails.cacheReadTokens).toBe(11264)
    expect(usage?.inputTokenDetails.noCacheTokens).toBe(16006 - 11264)
    expect(usage?.outputTokenDetails.reasoningTokens).toBe(23)
    expect(usage?.reasoningTokens).toBe(23)
  })

  it('falls back to flat _meta counters when there is no nested usage', () => {
    const usage = GROK_CONFIG.parseUsage?.({ totalTokens: 500, inputTokens: 480, outputTokens: 20 })
    expect(usage?.inputTokens).toBe(480)
    expect(usage?.outputTokens).toBe(20)
    expect(usage?.totalTokens).toBe(500)
  })

  it('derives totalTokens from input+output when the counter is absent', () => {
    const usage = GROK_CONFIG.parseUsage?.({ usage: { inputTokens: 480, outputTokens: 20 } })
    expect(usage?.totalTokens).toBe(500)
  })

  it('returns undefined when _meta carries no usage', () => {
    expect(GROK_CONFIG.parseUsage?.(undefined)).toBeUndefined()
    expect(GROK_CONFIG.parseUsage?.({ sessionId: 'x' })).toBeUndefined()
  })

  it('reads the context gauge, and only from a real reading', () => {
    expect(GROK_CONFIG.parseContextTokens?.({ totalTokens: 14_986 })).toBe(14_986)
    expect(GROK_CONFIG.parseContextTokens?.(undefined)).toBeUndefined()
    expect(GROK_CONFIG.parseContextTokens?.({ eventId: 'x' })).toBeUndefined()
    expect(GROK_CONFIG.parseContextTokens?.({ totalTokens: 0 })).toBeUndefined()
  })

  it('reads each model context window off the entry _meta', () => {
    const { models } = GROK_CONFIG.extractModels({
      initialize: {
        _meta: {
          modelState: {
            currentModelId: 'grok-4.5',
            availableModels: [
              { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { totalContextTokens: 500_000 } },
              { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5', _meta: { totalContextTokens: 200_000 } },
              { modelId: 'grok-no-window', name: 'No Window' },
            ],
          },
        },
      },
      session: null,
    } as never)

    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([
      ['grok-4.5', 500_000],
      ['grok-composer-2.5-fast', 200_000],
      ['grok-no-window', undefined],
    ])
  })

  it('probes commands, since Grok only pushes them after newSession', () => {
    // Guards the cost/benefit decision: commands arrive as a post-session push,
    // so dropping this flag silently empties the `/` menu until the first reply.
    expect(GROK_CONFIG.probeCommands).toBe(true)
  })

  it('classifies commands as skills only when _meta.path points at a SKILL.md', () => {
    const classify = (command: unknown) => GROK_CONFIG.classifyCommand?.(command as never)
    expect(
      classify({
        name: 'code-review',
        description: 'Strict review',
        _meta: { scope: 'user', path: '/Users/x/.grok/skills/code-review/SKILL.md' },
      }),
    ).toBe('skill')
    // Builtins carry no _meta at all.
    expect(classify({ name: 'compact', description: 'Compress history' })).toBe('command')
    expect(classify({ name: 'weird', description: '', _meta: { scope: 'user' } })).toBe('command')
    expect(classify({ name: 'blank-path', description: '', _meta: { path: '  ' } })).toBe('command')
  })
})
