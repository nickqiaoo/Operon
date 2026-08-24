/**
 * Regression tests for write-time slug identity-resolution.
 *
 * Covers the failure mode seen in real data: the same thing splitting across
 * multiple slugs (split-brain). Semantic (vector) dedup now lives in the
 * write-time guard in operations.ts and is delegated to the running agent;
 * here we only assert the deterministic identity layer (exact slug + normalized
 * slug key), which must work without any vector backend.
 *
 * The vector store is null on purpose — identity-first resolution must not depend on it.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { MemoryEngine, normalizeSlugKey } from './engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migration = (file: string) =>
  readFileSync(path.join(here, '../../storage/migrations', file), 'utf-8')
const SCHEMA = migration('0001_schema.sql')

function makeEngine(): MemoryEngine {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return new MemoryEngine(db, null)
}

const tl = (entry: string) => ({ entry })

describe('normalizeSlugKey', () => {
  it('collapses case / separators / punctuation to one identity key', () => {
    expect(normalizeSlugKey('Alice Smith')).toBe('alice-smith')
    expect(normalizeSlugKey('alice_smith')).toBe('alice-smith')
    expect(normalizeSlugKey('  Alice—Smith! ')).toBe('alice-smith')
  })

  it('keeps genuinely different slugs distinct', () => {
    expect(normalizeSlugKey('david-liu-meta')).not.toBe(normalizeSlugKey('david-liu-crustdata'))
  })

  it('keeps non-ASCII identities as real (non-empty) keys', () => {
    expect(normalizeSlugKey('大卫')).toBe('大卫')
    expect(normalizeSlugKey('  大卫! ')).toBe('大卫')
    expect(normalizeSlugKey('大卫')).not.toBe(normalizeSlugKey('小明'))
  })
})

describe('MemoryEngine slug dedup (identity-first)', () => {
  it('reuses the same page on an exact-slug rewrite — no split', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'slack-channel-c1', 'Channel named #general', tl('created'))
    const r = await e.upsert('entities', 'slack-channel-c1', 'Channel named #tech', tl('renamed'))

    expect(r.slug).toBe('slack-channel-c1')
    expect(r.merged).toBe(false)
    expect(e.listPages({ type: 'entities' })).toHaveLength(1)
    expect(e.getPage('entities', 'slack-channel-c1')?.truth).toBe('Channel named #tech')
  })

  it('merges a differently-formatted slug for the same identity', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'Alice Smith', 'A founder', tl('met'))
    const r = await e.upsert('entities', 'alice-smith', 'A founder at Acme', tl('update'))

    expect(r.merged).toBe(true)
    expect(r.slug).toBe('Alice Smith')
    expect(e.listPages({ type: 'entities' })).toHaveLength(1)
  })
})

describe('MemoryEngine.resolveExistingSlug', () => {
  it('returns null for an unknown identity (would mint a new page)', () => {
    const e = makeEngine()
    expect(e.resolveExistingSlug('entities', 'brand-new-thing')).toBeNull()
  })

  it('resolves an exact slug and a slug-key variant to the stored slug', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'Acme Corp', 'A robotics startup', tl('met'))

    expect(e.resolveExistingSlug('entities', 'Acme Corp')).toBe('Acme Corp')
    expect(e.resolveExistingSlug('entities', 'acme-corp')).toBe('Acme Corp')
    expect(e.resolveExistingSlug('entities', 'acme_corp')).toBe('Acme Corp')
  })

  it('forces singleton types to the singleton slug', () => {
    const e = makeEngine()
    expect(e.resolveExistingSlug('user', 'whatever')).toBe('user')
    expect(e.resolveExistingSlug('user', 'anything')).toBe('user')
  })
})

describe('MemoryEngine alias resolution (learned identity)', () => {
  it('resolves a learned alias to its canonical page', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'david-liu', 'A founder at Crustdata', tl('met'))

    // An unrelated name does not resolve until it is learned.
    expect(e.resolveExistingSlug('entities', '大卫')).toBeNull()
    e.recordAlias('entities', '大卫', 'david-liu')
    expect(e.resolveExistingSlug('entities', '大卫')).toBe('david-liu')
  })

  it('no-ops when the alias key equals the page slug key', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'David Liu', 'A founder', tl('met'))
    e.recordAlias('entities', 'david-liu', 'David Liu') // same key — nothing to learn
    // still resolves via the slug-key path, not a spurious alias row
    expect(e.resolveExistingSlug('entities', 'david_liu')).toBe('David Liu')
  })

  it('refuses to shadow a distinct real page that owns the key', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'acme', 'Robotics startup', tl('a'))
    await e.upsert('entities', 'globex', 'Conglomerate', tl('b'))
    e.recordAlias('entities', 'acme', 'globex') // must not hijack the real acme page
    expect(e.resolveExistingSlug('entities', 'acme')).toBe('acme')
  })

  it('keeps the first mapping on a conflicting alias', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'page-a', 'A', tl('a'))
    await e.upsert('entities', 'page-b', 'B', tl('b'))
    e.recordAlias('entities', 'nickname', 'page-a')
    e.recordAlias('entities', 'nickname', 'page-b') // ignored — first writer wins
    expect(e.resolveExistingSlug('entities', 'nickname')).toBe('page-a')
  })

  it('drops a dangling alias when its target page is deleted', async () => {
    const e = makeEngine()
    await e.upsert('entities', 'david-liu', 'A founder', tl('met'))
    e.recordAlias('entities', '大卫', 'david-liu')
    expect(e.resolveExistingSlug('entities', '大卫')).toBe('david-liu')

    await e.deletePage('entities', 'david-liu')
    expect(e.resolveExistingSlug('entities', '大卫')).toBeNull()
  })

  it('ignores aliases for singleton types', () => {
    const e = makeEngine()
    e.recordAlias('user', 'whatever', 'user') // no-op
    expect(e.resolveExistingSlug('user', 'whatever')).toBe('user')
  })
})
