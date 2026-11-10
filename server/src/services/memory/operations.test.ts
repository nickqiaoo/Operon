import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { MemoryEngine } from './engine.js'
import {
  execMemorySearch,
  execMemoryUpsert,
  MEMORY_MCP_TOOLS,
  selectTimelineForModel,
} from './operations.js'
import type { MemoryPageResult } from './types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migration = (file: string) =>
  readFileSync(path.join(here, '../../storage/migrations', file), 'utf-8')
const SCHEMA = migration('0001_schema.sql') + migration('0023_memory_timeline_provenance.sql')

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

  it.each(['acme', 'ACME', 'Acme!'])(
    'appends directly when the hint %s names an existing page, keeping truth',
    async (hint) => {
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
          slug_hint: hint,
          content: 'Jane is Acme CTO.',
          reason: 'User updated Acme.',
        }),
      )

      expect(result.status).toBe('written')
      expect(result.action).toBe('appended')
      expect(result.slug).toBe('acme')
      expect(result.truth).toBe('Acme is a robotics startup.')
      expect(result.revision).toBe(1)
      expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is a robotics startup.')
      expect(engine.getTimelineRecent('entities', 'acme', 10)).toHaveLength(2)
    },
  )

  it('appends directly to the singleton user page', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'user',
      content: 'User works in TypeScript.',
      reason: 'User: "I write TypeScript"',
    })

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'user',
        content: 'User lives in Shenzhen.',
        reason: 'User: "I live in Shenzhen"',
      }),
    )

    expect(result.status).toBe('written')
    expect(result.action).toBe('appended')
    expect(engine.getTimelineRecent('user', 'user', 10)).toHaveLength(2)
  })

  it('does not duplicate the entry when truth is rewritten after a direct append', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is in Berlin.',
      reason: 'User introduced Acme.',
    })
    const write = { type: 'entities', slug_hint: 'acme', content: 'Acme moved to Munich.', reason: 'User: "they moved"' }
    const appended = parseObject(await execMemoryUpsert(engine, write))

    const result = parseObject(
      await execMemoryUpsert(engine, {
        ...write,
        decision: {
          action: 'merge',
          target_slug: 'acme',
          base_revision: appended.revision,
          truth: 'Acme is in Munich.',
        },
      }),
    )

    expect(result.action).toBe('merged')
    expect(result.revision).toBe(2)
    expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is in Munich.')
    expect(engine.getTimelineRecent('entities', 'acme', 10)).toHaveLength(2)
  })

  it('still asks the agent to decide when the hint is only an alias', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'operon',
      content: 'Operon is a developer tool.',
      reason: 'User introduced Operon.',
    })
    engine.recordAlias('entities', 'xui', 'operon')

    const result = parseObject(
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'xui',
        content: 'The xui folder is a legacy name.',
        reason: 'User explained the folder.',
      }),
    )

    expect(result.status).toBe('needs_reconcile')
    const candidate = candidateAt(result, 0)
    expect(candidate.slug).toBe('operon')
    expect(candidate.match).toBe('identity')
    expect(engine.getTimelineRecent('entities', 'operon', 10)).toHaveLength(1)
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

  it('appends to the timeline and keeps truth when merge omits truth', async () => {
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
        content: '2026-11-08: Acme moved its demo to Friday.',
        reason: 'User mentioned the demo.',
        decision: { action: 'merge', target_slug: 'acme' },
      }),
    )

    expect(result.status).toBe('written')
    expect(result.action).toBe('appended')
    expect(result.revision).toBe(1)
    expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is a robotics startup.')
    expect(engine.getTimelineRecent('entities', 'acme', 5).map((t) => t.entry)).toContain(
      '2026-11-08: Acme moved its demo to Friday.',
    )
  })

  it('still requires base_revision when merge rewrites truth', async () => {
    const engine = makeEngine()
    await execMemoryUpsert(engine, {
      type: 'entities',
      slug_hint: 'acme',
      content: 'Acme is a robotics startup.',
      reason: 'User introduced Acme.',
    })

    await expect(
      execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Jane is Acme CTO.',
        reason: 'User updated Acme.',
        decision: { action: 'merge', target_slug: 'acme', truth: 'Acme. Jane is CTO.' },
      }),
    ).rejects.toThrow('base_revision')
    expect(engine.getPage('entities', 'acme')?.truth).toBe('Acme is a robotics startup.')
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

describe('retired events type', () => {
  it('rejects new writes and is not offered to the agent', async () => {
    const engine = makeEngine()

    await expect(
      execMemoryUpsert(engine, {
        type: 'events',
        slug_hint: 'launch',
        content: 'Acme launched.',
        reason: 'User: "we launched"',
      }),
    ).rejects.toThrow('read-only')

    const upsert = MEMORY_MCP_TOOLS.find((tool) => tool.name === 'memory_upsert')
    const properties = upsert?.inputSchema.properties as { type: { enum: string[] } }
    expect(properties.type.enum).toEqual(['user', 'entities', 'cases'])
  })

  it('keeps existing pages searchable', async () => {
    const engine = makeEngine()
    await engine.createPage('events', 'acme-launch', 'Acme launched.', { entry: 'Acme launched.' })

    const result = await execMemorySearch(engine, { types: ['events'], since: '2020-01-01' })

    expect(result).toContain('acme-launch')
  })
})

describe('selectTimelineForModel', () => {
  // Newest first, as memorySearch returns them: id 1 is the newest.
  const entries = (relevances: number[]): MemoryPageResult['timeline'] =>
    relevances.map((relevance, i) => ({
      id: i + 1,
      occurred_at: 1000 - i,
      entry: `entry ${i + 1}`,
      reason: null,
      matched: true,
      relevance,
    }))

  it('keeps the most relevant entries and shows them in time order', () => {
    const picked = selectTimelineForModel('ios sharing', {
      slug: 'acme',
      timeline: entries([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.6]),
    })
    expect(picked.timeline.map((t) => t.id)).toEqual([2, 4, 5, 6, 7])
    expect(picked.omitted).toBe(2)
  })

  it('keeps the newest entries when the query only names the page', () => {
    const picked = selectTimelineForModel('Acme', {
      slug: 'acme',
      timeline: entries([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.6]),
    })
    expect(picked.timeline.map((t) => t.id)).toEqual([1, 2, 3, 4, 5])
    expect(picked.omitted).toBe(2)
  })

  it('omits nothing at or under the cap', () => {
    const picked = selectTimelineForModel('ios', { slug: 'acme', timeline: entries([1, 2, 3, 4, 5]) })
    expect(picked.timeline).toHaveLength(5)
    expect(picked.omitted).toBe(0)
  })
})

describe('execMemorySearch filters', () => {
  async function seed(engine: MemoryEngine, slug: string, facts: Array<[string, string]>) {
    for (const [i, [content, occurred_at]] of facts.entries()) {
      await execMemoryUpsert(engine, {
        type: 'entities',
        slug_hint: slug,
        content,
        reason: 'User said so.',
        occurred_at,
        ...(i === 0 ? {} : { decision: { action: 'merge', target_slug: slug } }),
      })
    }
  }

  type Page = { slug: string; timeline: Array<{ entry: string }>; timeline_omitted?: number }
  const search = async (engine: MemoryEngine, args: Parameters<typeof execMemorySearch>[1]) =>
    JSON.parse(await execMemorySearch(engine, args)) as Page[]
  const entriesOf = (page: Page | undefined) => page?.timeline.map((t) => t.entry)

  it('lists a date range newest first without a query, counting the whole last day', async () => {
    const engine = makeEngine()
    await seed(engine, 'acme', [
      ['first launch notes', '2026-11-01'],
      ['second launch notes', '2026-11-03'],
      ['third launch notes', '2026-11-05'],
    ])

    const [page] = await search(engine, { since: '2026-11-02', until: '2026-11-05' })
    expect(entriesOf(page)).toEqual(['third launch notes', 'second launch notes'])
  })

  it('applies the date range to a keyword search', async () => {
    const engine = makeEngine()
    await seed(engine, 'acme', [
      ['first launch notes', '2026-11-01'],
      ['second launch notes', '2026-11-03'],
    ])

    const [page] = await search(engine, { query: 'launch', since: '2026-11-02' })
    expect(entriesOf(page)).toEqual(['second launch notes'])
  })

  it('does not let a truth hit bring in a page with no entry in range', async () => {
    const engine = makeEngine()
    await seed(engine, 'acme', [['robotics startup', '2026-10-01']])

    const text = await execMemorySearch(engine, { query: 'robotics', since: '2026-11-01' })
    expect(text).toBe('No matching memory pages.')
  })

  it('restricts to one page by slug and reports what it left out', async () => {
    const engine = makeEngine()
    await seed(engine, 'acme', [
      ['one launch', '2026-11-01'],
      ['two launch', '2026-11-02'],
      ['three launch', '2026-11-03'],
      ['four launch', '2026-11-04'],
      ['five launch', '2026-11-05'],
      ['six launch', '2026-11-06'],
    ])
    await seed(engine, 'globex', [['other launch', '2026-11-07']])

    const pages = await search(engine, { slug: 'acme' })
    expect(pages.map((p) => p.slug)).toEqual(['acme'])
    expect(pages[0]?.timeline).toHaveLength(5)
    expect(pages[0]?.timeline_omitted).toBe(1)
  })

  it('returns no pages for an unknown slug and rejects a reversed range', async () => {
    const engine = makeEngine()
    expect(await execMemorySearch(engine, { slug: 'nobody' })).toBe('No matching memory pages.')
    await expect(
      execMemorySearch(engine, { since: '2026-11-05', until: '2026-11-01' }),
    ).rejects.toThrow('since must not be after until')
  })

  it('needs a query or a filter', async () => {
    await expect(execMemorySearch(makeEngine(), {})).rejects.toThrow('query is required')
  })
})

describe('execMemoryUpsert timeline provenance', () => {
  it('records the content as the entry, with reason and source beside it', async () => {
    const engine = makeEngine()
    const since = Date.now()
    await execMemoryUpsert(
      engine,
      {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Acme is a robotics startup.',
        reason: 'User: "Acme makes warehouse robots"',
      },
      { source: 'chat:7' },
    )
    const first = parseObject(
      await execMemoryUpsert(
        engine,
        {
          type: 'entities',
          slug_hint: 'acme',
          content: 'Acme moved from Berlin to Munich.',
          reason: 'User: "they relocated to Munich"',
        },
        { source: 'chat:7' },
      ),
    )
    await execMemoryUpsert(
      engine,
      {
        type: 'entities',
        slug_hint: 'acme',
        content: 'Acme moved from Berlin to Munich.',
        reason: 'User: "they relocated to Munich"',
        decision: {
          action: 'merge',
          target_slug: 'acme',
          base_revision: first.revision,
          truth: 'Acme is a robotics startup based in Munich.',
        },
      },
      { source: 'chat:7' },
    )

    const timeline = engine.getTimelineRecent('entities', 'acme', 10)
    expect(timeline.map((t) => t.entry).sort()).toEqual([
      'Acme is a robotics startup.',
      'Acme moved from Berlin to Munich.',
    ])
    const merged = timeline.find((t) => t.entry.startsWith('Acme moved'))
    expect(merged?.reason).toBe('User: "they relocated to Munich"')
    expect(merged?.source).toBe('chat:7')

    // The truth rewrite reused the appended entry; the two facts are what counts.
    expect(engine.countTimelineEntries({ source: 'chat:7', since })).toBe(2)
    expect(engine.countTimelineEntries({ source: 'chat:8', since })).toBe(0)
  })
})
