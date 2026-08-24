import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { MemoryEngine } from './engine.js'
import { execMemoryUpsert } from './operations.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migration = (file: string) =>
  readFileSync(path.join(here, '../../storage/migrations', file), 'utf-8')
const SCHEMA = migration('0001_schema.sql')

function makeEngine(): MemoryEngine {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return new MemoryEngine(db, null)
}

function parseObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object JSON')
  }
  return value as Record<string, unknown>
}

function candidateAt(result: Record<string, unknown>, index: number): Record<string, unknown> {
  const candidates = result.candidates
  if (!Array.isArray(candidates)) throw new Error('expected candidates')
  const candidate = candidates[index]
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('expected candidate object')
  }
  return candidate as Record<string, unknown>
}

describe('execMemoryUpsert reconcile flow', () => {
  it('creates a new page when no identity or semantic candidate exists', async () => {
    const engine = makeEngine()

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Acme is a robotics startup.',
        reason: 'User introduced Acme.',
      }),
    )

    expect(result.status).toBe('written')
    expect(result.action).toBe('created')
    expect(result.revision).toBe(1)
    expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is a robotics startup.')
  })

  it('returns needs_reconcile for an existing identity without replacing truth', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is a robotics startup.',
      reason: 'User introduced Acme.',
    })

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Jane is Acme CTO.',
        reason: 'User updated Acme.',
      }),
    )

    expect(result.status).toBe('needs_reconcile')
    const candidate = candidateAt(result, 0)
    expect(candidate.slug).toBe('acme')
    expect(candidate.truth).toBe('Acme is a robotics startup.')
    expect(candidate.revision).toBe(1)
    expect(candidate.match).toBe('identity')
    expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is a robotics startup.')
    expect(engine.getTimelineRecent('entities', 'acme', 10)).toHaveLength(1)
  })

  it('merges only when the agent supplies full truth and matching base revision', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is a robotics startup.',
      reason: 'User introduced Acme.',
    })

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Jane is Acme CTO.',
        reason: 'User updated Acme.',
        decision: {
          action: 'merge',
          target_slug: 'acme',
          base_revision: 1,
          truth: 'Acme is a robotics startup. Jane is Acme CTO.',
        },
      }),
    )

    expect(result.status).toBe('written')
    expect(result.action).toBe('merged')
    expect(result.revision).toBe(2)
    expect(engine.getPage('entities', 'acme')?.truth).toBe(
      'Acme is a robotics startup. Jane is Acme CTO.',
    )
  })

  it('rejects stale merge decisions without replacing truth', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is a robotics startup.',
      reason: 'User introduced Acme.',
    })
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Jane is Acme CTO.',
      reason: 'User updated Acme.',
      decision: {
        action: 'merge',
        target_slug: 'acme',
        base_revision: 1,
        truth: 'Acme is a robotics startup. Jane is Acme CTO.',
      },
    })

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Acme moved offices.',
        reason: 'User updated Acme again.',
        decision: {
          action: 'merge',
          target_slug: 'acme',
          base_revision: 1,
          truth: 'Acme moved offices.',
        },
      }),
    )

    expect(result.status).toBe('conflict')
    expect(result.reason).toBe('revision_mismatch')
    expect(engine.getPage('entities', 'acme')?.truth).toBe(
      'Acme is a robotics startup. Jane is Acme CTO.',
    )
  })

  it('does not let a create decision overwrite an existing identity', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is a robotics startup.',
      reason: 'User introduced Acme.',
    })

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'A different Acme record.',
        reason: 'User mentioned another Acme.',
        decision: { action: 'create' },
      }),
    )

    expect(result.status).toBe('needs_reconcile')
    expect(candidateAt(result, 0).truth).toBe('Acme is a robotics startup.')
    expect(engine.listPages({ type: 'entities' })).toHaveLength(1)
  })
})
