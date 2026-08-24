/**
 * Tests for the lightweight entity-aware boost (search/hybrid.ts).
 *
 * Covers the three pure pieces independent of the cross-encoder:
 *   - detectQueryEntities: which existing `entities` pages a query names
 *   - resultMentionsEntity: own-page vs all-tokens text mention
 *   - computeEntityBoosts: diffusion decay + multi-entity stacking
 *
 * The vector store is null on purpose — entity matching is identity/text based and must work
 * with no vector backend (mirrors engine.dedup.test.ts).
 */
import { describe, it, expect } from 'vitest'
import type { MemoryEngine } from '../engine.js'
import type { MemoryPage, MemoryPageResult } from '../types.js'
import {
  detectQueryEntities,
  resultMentionsEntity,
  computeEntityBoosts,
  type QueryEntity,
} from './hybrid.js'

/**
 * Stub engine exposing only `listPages` — keeps these tests off better-sqlite3's
 * native binding (whose ABI is pinned to the Electron runtime, not plain Node),
 * so the boost logic is verifiable under CI. The real listPages query is covered
 * by engine.dedup.test.ts.
 */
function fakeEngine(entitySlugs: string[]): MemoryEngine {
  const pages: MemoryPage[] = entitySlugs.map((slug) => ({
    type: 'entities',
	    slug,
	    truth: '',
	    revision: 1,
	    updated_at: 0,
	  }))
  return { listPages: () => pages } as unknown as MemoryEngine
}

function result(over: Partial<MemoryPageResult>): MemoryPageResult {
  return {
    type: 'cases',
	    slug: 'x',
	    truth: '',
	    revision: 1,
	    updated_at: 0,
    timeline: [],
    ...over,
  }
}

const entity = (key: string): QueryEntity => ({ key, tokens: key.split('-').filter(Boolean) })

describe('detectQueryEntities', () => {
  it('matches an entity only when all of its slug tokens appear in the query', () => {
    const engine = fakeEngine(['alice-smith', 'openai'])

    const both = detectQueryEntities(engine, 'what does alice smith prefer for deploys')
    expect(both.map((e) => e.key)).toEqual(['alice-smith'])

    const single = detectQueryEntities(engine, 'tell me about openai pricing')
    expect(single.map((e) => e.key)).toEqual(['openai'])

    // Partial name must NOT match a multi-token entity (precision).
    const partial = detectQueryEntities(engine, 'who is alice')
    expect(partial).toEqual([])
  })

  it('returns nothing when there are no entity pages', () => {
    expect(detectQueryEntities(fakeEngine([]), 'anything')).toEqual([])
  })
})

describe('resultMentionsEntity', () => {
  it('matches the entity own page regardless of text', () => {
    const r = result({ type: 'entities', slug: 'Alice-Smith', truth: '' })
    expect(resultMentionsEntity(r, entity('alice-smith'))).toBe(true)
  })

  it('matches when the text contains all entity tokens (truth or timeline)', () => {
    const inTruth = result({ truth: 'We onboarded Alice Smith last week.' })
    expect(resultMentionsEntity(inTruth, entity('alice-smith'))).toBe(true)

    const inTimeline = result({
      truth: 'unrelated',
      timeline: [{ id: 1, occurred_at: 0, entry: 'alice smith joined the channel', matched: true }],
    })
    expect(resultMentionsEntity(inTimeline, entity('alice-smith'))).toBe(true)
  })

  it('does not match when a required token is missing', () => {
    const r = result({ truth: 'Alice was here but Bob left.' })
    expect(resultMentionsEntity(r, entity('alice-smith'))).toBe(false)
  })
})

describe('computeEntityBoosts', () => {
  it('returns all-zero when no query entities', () => {
    const results = [result({ truth: 'a' }), result({ truth: 'b' })]
    expect(computeEntityBoosts(results, [])).toEqual([0, 0])
  })

  it('decays a hub entity below a rare one (diffusion decay)', () => {
    // 30 results mention "common", exactly 1 mentions "rare".
    const results: MemoryPageResult[] = []
    for (let i = 0; i < 30; i++) results.push(result({ truth: 'common topic' }))
    results.push(result({ truth: 'rare topic' }))

    const boosts = computeEntityBoosts(results, [entity('common'), entity('rare')])

    const hub = boosts[0]! // mentions "common" only
    const rare = boosts[30]! // mentions "rare" only
    expect(rare).toBeCloseTo(0.15, 5) // n=1 → no decay
    expect(hub).toBeLessThan(rare) // n=30 → decayed
    expect(hub).toBeGreaterThan(0)
  })

  it('stacks boosts from multiple matched entities on one result', () => {
    const results = [result({ truth: 'alice and bob paired up' })]
    const [stacked] = computeEntityBoosts(results, [entity('alice'), entity('bob')])
    // Both are rare (n=1) → full weight each, summed.
    expect(stacked).toBeCloseTo(0.3, 5)
  })

  it('honors a custom weight', () => {
    const results = [result({ truth: 'about bob' })]
    expect(computeEntityBoosts(results, [entity('bob')], 0.5)).toEqual([0.5])
  })
})
