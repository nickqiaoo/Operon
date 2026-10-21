import { describe, expect, it } from 'vitest'
import { coordinatorSeat, defaultSpecConfig, familyOf, parseNamedAgent, reviewerFor, seatFor, withBuildDefaults } from './config.js'
import { builderAgentName, getOrCreateSpecBuilder } from './builders.js'
import type { Agent } from '../../types/channel.js'

describe('defaultSpecConfig', () => {
  it('takes two candidates from different families and a judge outside the lead\'s family', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex', 'grok', 'custom'],
      lead: { providerId: 'claude-code', modelId: 'opus' },
    })
    expect(config.candidates.map((c) => c.providerId)).toEqual(['claude-code', 'codex'])
    expect(config.judge.providerId).toBe('grok')
    expect(familyOf(config.judge.providerId)).not.toBe(familyOf(config.lead.providerId))
  })

  it('gives only the lead\'s own provider the chat\'s model', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex'],
      lead: { providerId: 'claude-code', modelId: 'opus' },
    })
    expect(config.candidates[0]).toEqual({ providerId: 'claude-code', modelId: 'opus' })
    expect(config.candidates[1]).toEqual({ providerId: 'codex' })
  })

  it('uses the providers the user named, as many as they named', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex', 'grok', 'kimi'],
      lead: { providerId: 'codex' },
      candidates: ['grok', 'kimi', 'claude-code'],
    })
    expect(config.candidates.map((c) => c.providerId)).toEqual(['grok', 'kimi', 'claude-code'])
  })

  it('runs both candidates on a single named provider instead of adding another', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex', 'grok'],
      lead: { providerId: 'codex', modelId: 'gpt-5.6-terra' },
      candidates: ['codex'],
    })
    expect(config.candidates).toEqual([
      { providerId: 'codex', modelId: 'gpt-5.6-terra' },
      { providerId: 'codex', modelId: 'gpt-5.6-terra' },
    ])
    const seats = [config.explorer, config.judge, config.builder].map((s) => s.providerId)
    expect(new Set(seats)).toEqual(new Set(['codex']))
  })

  it('keeps every seat inside the named agents (plus the lead)', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex', 'grok', 'opencode'],
      lead: { providerId: 'codex' },
      candidates: ['codex', 'opencode'],
    })
    const seats = [config.explorer, config.judge, config.builder, ...config.candidates].map((s) => s.providerId)
    expect(new Set(seats)).toEqual(new Set(['codex', 'opencode']))
    // The judge still comes from outside the lead's family when the named set allows it.
    expect(config.judge.providerId).toBe('opencode')
  })

  it('ignores named providers that are not available', () => {
    const config = defaultSpecConfig({
      available: ['claude-code', 'codex'],
      lead: { providerId: 'codex' },
      candidates: ['grok'],
    })
    expect(config.candidates.map((c) => c.providerId)).toEqual(['claude-code', 'codex'])
  })

  it('refuses to start with fewer than two candidates', () => {
    expect(() => defaultSpecConfig({ available: [], lead: { providerId: 'custom', modelId: 'm' } })).toThrow(
      /at least two design candidates/,
    )
  })
})

describe('build-stage seats', () => {
  const config = defaultSpecConfig({
    available: ['codex', 'claude-code'],
    lead: { providerId: 'codex', modelId: 'gpt-5.6-terra' },
    candidates: ['codex'],
  })

  it('runs the lead\'s provider on the lead\'s model and any other provider on its default', () => {
    expect(seatFor(config, 'codex')).toEqual({ providerId: 'codex', modelId: 'gpt-5.6-terra' })
    expect(seatFor(config, 'claude-code')).toEqual({ providerId: 'claude-code' })
  })

  it('keeps one builder agent per provider and model, carrying the model', () => {
    const agents = new Map<string, Agent>()
    const storage = {
      getAgentByName: (name: string) => agents.get(name) ?? null,
      createAgent: (input: Partial<Agent>) => {
        const agent = { id: agents.size + 1, ...input } as Agent
        agents.set(agent.name, agent)
        return agent
      },
    }
    const terra = getOrCreateSpecBuilder(storage, seatFor(config, 'codex'))
    expect(terra.model).toBe('gpt-5.6-terra')
    expect(getOrCreateSpecBuilder(storage, { providerId: 'codex' }).model).toBe('')
    expect(getOrCreateSpecBuilder(storage, seatFor(config, 'codex'))).toBe(terra)
    expect(builderAgentName({ providerId: 'codex' })).toBe('Spec builder · codex')
  })
})

describe('naming a model with an agent', () => {
  const config = defaultSpecConfig({
    available: ['codex', 'opencode', 'claude-code'],
    lead: { providerId: 'codex', modelId: 'gpt-6-luna' },
    candidates: ['codex', 'opencode:opencode/deepseek-v4.1-flash-free'],
  })

  it('parses provider:model at the first colon', () => {
    expect(parseNamedAgent('opencode:opencode/deepseek-v4.1-flash-free')).toEqual({
      providerId: 'opencode',
      modelId: 'opencode/deepseek-v4.1-flash-free',
    })
    expect(parseNamedAgent('ollama:llama3:8b')).toEqual({ providerId: 'ollama', modelId: 'llama3:8b' })
    expect(parseNamedAgent('codex')).toEqual({ providerId: 'codex' })
  })

  it('runs every seat of that provider on it, and the lead\'s provider on the lead\'s model', () => {
    expect(config.candidates).toEqual([
      { providerId: 'codex', modelId: 'gpt-6-luna' },
      { providerId: 'opencode', modelId: 'opencode/deepseek-v4.1-flash-free' },
    ])
    expect(config.judge).toEqual({ providerId: 'opencode', modelId: 'opencode/deepseek-v4.1-flash-free' })
  })

  it('carries the named model into the build stage', () => {
    expect(seatFor(config, 'opencode')).toEqual({ providerId: 'opencode', modelId: 'opencode/deepseek-v4.1-flash-free' })
    expect(withBuildDefaults(config).implementer).toEqual({ providerId: 'codex', modelId: 'gpt-6-luna' })
  })
})

describe('roles from Settings', () => {
  const available = ['claude-code', 'codex', 'grok', 'opencode']
  const lead = { providerId: 'claude-code', modelId: 'opus' }

  it('fills every configured seat, the build seats too', () => {
    const config = defaultSpecConfig({
      available,
      lead,
      roles: {
        lead: { providerId: 'codex', modelId: 'gpt-5' },
        judge: { providerId: 'opencode', modelId: 'vendor/cheap' },
        candidates: [{ providerId: 'grok' }, { providerId: 'claude-code' }],
        implementer: { providerId: 'opencode' },
        reviewer: { providerId: 'grok' },
        coordinator: { providerId: 'claude-code' },
      },
    })
    expect(config.lead).toEqual({ providerId: 'codex', modelId: 'gpt-5' })
    expect(config.judge).toEqual({ providerId: 'opencode', modelId: 'vendor/cheap' })
    expect(config.candidates.map((c) => c.providerId)).toEqual(['grok', 'claude-code'])
    expect(withBuildDefaults(config).implementer).toEqual({ providerId: 'opencode' })
    // A reviewer the user picked reviews every ticket, whatever family built it.
    expect(reviewerFor(config, 'grok')).toBe('grok')
    expect(coordinatorSeat(config)).toEqual({ providerId: 'claude-code' })
  })

  it('leaves unset roles automatic, and ignores agents that are not usable here', () => {
    const auto = defaultSpecConfig({ available, lead })
    const config = defaultSpecConfig({ available, lead, roles: { judge: { providerId: 'kimi' } } })
    expect(config).toEqual(auto)
    expect(coordinatorSeat(config)).toEqual(lead)
  })

  it('keeps an automatic second candidate beside a single configured one, and agents named in the chat win', () => {
    const one = defaultSpecConfig({ available, lead, roles: { candidates: [{ providerId: 'opencode' }] } })
    expect(one.candidates).toHaveLength(2)
    expect(one.candidates[0]).toEqual({ providerId: 'opencode' })
    expect(one.candidates[1].providerId).not.toBe('opencode')

    const named = defaultSpecConfig({ available, lead, candidates: ['codex', 'grok'], roles: { candidates: [{ providerId: 'opencode' }] } })
    expect(named.candidates.map((c) => c.providerId)).toEqual(['codex', 'grok'])
  })
})
