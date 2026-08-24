/**
 * SqliteVecStore — behaviours that the previous zvec backend gave us for free
 * and that vec0 does *not*, so a regression here would be silent.
 *
 * The filter tests use a deliberate construction: every vector that is *near*
 * the query has one scope, every vector that is *far* has another. A real
 * pushdown (filter applied during the KNN scan) then returns a full page of
 * results; a filter that degraded into a post-filter over the global top-k
 * returns nothing. vec0 silently degrades for `OR` / `NOT IN`, which is exactly
 * why the store only accepts a structured `VectorFilter`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StorageAdapter } from '../../storage/interface.js'

const DIM = 8
const COLLECTION = 'testcol'

let tmpDir: string
/** Re-imported per test because VECTOR_DIR is captured at module load. */
let store: import('./sqlite-vec-store.js').SqliteVecStore

/** Minimal in-memory StorageAdapter so getEmbeddingConfig() returns our dimension. */
function memoryStorage(dimensions: number): StorageAdapter {
  const map = new Map<string, unknown>()
  map.set('embedding-provider-config', { enabled: true, dimensions })
  return {
    get: (k: string) => map.get(k),
    set: (k: string, v: unknown) => void map.set(k, v),
    delete: (k: string) => void map.delete(k),
    getAll: () => undefined,
    setAll: () => {},
    keys: () => Array.from(map.keys()),
  } as StorageAdapter
}

async function loadStore(dimensions = DIM) {
  // Fresh module registry so VECTOR_DIR and the singleton are re-evaluated.
  const { initEmbeddingConfig } = await import('./embeddings.js')
  initEmbeddingConfig(memoryStorage(dimensions))
  const mod = await import('./sqlite-vec-store.js')
  return mod.SqliteVecStore.init()
}

/** Unit vector pointing `angle` away from [1, 0, …]; larger i ⇒ farther. */
function vec(i: number, dim = DIM): number[] {
  const v = new Array(dim).fill(0)
  v[0] = 1
  v[1] = i / 100
  return v
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecstore-'))
  process.env.OPERON_VECTOR_DIR = tmpDir
  // The store captures VECTOR_DIR at module load, so each test needs a fresh
  // module instance to be pointed at its own sandbox.
  vi.resetModules()
})

afterEach(() => {
  try {
    store?.close()
  } catch {
    // already closed
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.OPERON_VECTOR_DIR
})

describe('SqliteVecStore', () => {
  it('round-trips a vector and reports cosine distance 0 against itself', async () => {
    store = await loadStore()
    store.insert(COLLECTION, 'a', vec(0), {
      category: 'truth',
      scope: 'entities',
      source_id: 'alice',
    })

    const hits = store.search(COLLECTION, vec(0), 5)
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('a')
    expect(hits[0].score).toBeLessThan(1e-6)
    expect(hits[0].fields).toEqual({
      category: 'truth',
      scope: 'entities',
      source_id: 'alice',
    })
  })

  it('keeps cosine distance on zvec’s scale (0 / 1 / 2), so tuned thresholds carry over', async () => {
    store = await loadStore(2)
    const f = { category: 'truth', scope: 'entities', source_id: 'x' }
    store.insert(COLLECTION, 'same', [1, 0], f)
    store.insert(COLLECTION, 'ortho', [0, 1], f)
    store.insert(COLLECTION, 'opposite', [-1, 0], f)
    // Magnitude must not matter — cosine normalises internally.
    store.insert(COLLECTION, 'scaled', [7, 0], f)

    const byId = new Map(store.search(COLLECTION, [1, 0], 4).map((h) => [h.id, h.score]))
    expect(byId.get('same')).toBeCloseTo(0, 5)
    expect(byId.get('scaled')).toBeCloseTo(0, 5)
    expect(byId.get('ortho')).toBeCloseTo(1, 5)
    expect(byId.get('opposite')).toBeCloseTo(2, 5)
  })

  it('upserts by id instead of erroring on a duplicate primary key', async () => {
    store = await loadStore()
    const fields = { category: 'truth', scope: 'entities', source_id: 'alice' }
    store.insert(COLLECTION, 'a', vec(0), fields)
    // vec0 rejects a plain re-INSERT *and* INSERT OR REPLACE on a text PK; the
    // store has to delete-then-insert. storeTruthVector() relies on this.
    store.insert(COLLECTION, 'a', vec(50), { ...fields, source_id: 'alice-v2' })

    const hits = store.search(COLLECTION, vec(50), 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].score).toBeLessThan(1e-6)
    expect(hits[0].fields.source_id).toBe('alice-v2')
  })

  it('pushes a single-scope filter into the KNN scan', async () => {
    store = await loadStore()
    // The 20 nearest are all `events`; the 20 farthest are all `entities`.
    for (let i = 0; i < 20; i++) {
      store.insert(COLLECTION, `near${i}`, vec(i), {
        category: 'timeline',
        scope: 'events',
        source_id: String(i),
      })
    }
    for (let i = 0; i < 20; i++) {
      store.insert(COLLECTION, `far${i}`, vec(100 + i), {
        category: 'truth',
        scope: 'entities',
        source_id: String(i),
      })
    }

    const hits = store.search(COLLECTION, vec(0), 10, { scope: 'entities' })
    // Post-filtering the global top-10 would yield 0 rows.
    expect(hits).toHaveLength(10)
    expect(hits.every((h) => h.fields.scope === 'entities')).toBe(true)
  })

  it('pushes a multi-scope IN filter into the KNN scan', async () => {
    store = await loadStore()
    for (let i = 0; i < 20; i++) {
      store.insert(COLLECTION, `near${i}`, vec(i), {
        category: 'timeline',
        scope: 'events',
        source_id: String(i),
      })
    }
    for (let i = 0; i < 10; i++) {
      store.insert(COLLECTION, `mid${i}`, vec(100 + i), {
        category: 'truth',
        scope: 'entities',
        source_id: String(i),
      })
      store.insert(COLLECTION, `far${i}`, vec(200 + i), {
        category: 'truth',
        scope: 'cases',
        source_id: String(i),
      })
    }

    const hits = store.search(COLLECTION, vec(0), 15, { scope: ['entities', 'cases'] })
    expect(hits).toHaveLength(15)
    expect(hits.every((h) => h.fields.scope === 'entities' || h.fields.scope === 'cases')).toBe(
      true,
    )
  })

  it('combines category and scope as a conjunction', async () => {
    store = await loadStore()
    for (let i = 0; i < 10; i++) {
      store.insert(COLLECTION, `t${i}`, vec(i), {
        category: 'timeline',
        scope: 'events',
        source_id: String(i),
      })
      store.insert(COLLECTION, `r${i}`, vec(100 + i), {
        category: 'truth',
        scope: 'events',
        source_id: String(i),
      })
    }

    const hits = store.search(COLLECTION, vec(0), 10, { category: 'truth', scope: 'events' })
    expect(hits).toHaveLength(10)
    expect(hits.every((h) => h.fields.category === 'truth')).toBe(true)
  })

  it('treats an empty scope array as "no constraint"', async () => {
    store = await loadStore()
    store.insert(COLLECTION, 'a', vec(0), {
      category: 'truth',
      scope: 'entities',
      source_id: 'alice',
    })
    expect(store.search(COLLECTION, vec(0), 5, { scope: [] })).toHaveLength(1)
  })

  it('deletes by id', async () => {
    store = await loadStore()
    const fields = { category: 'truth', scope: 'entities', source_id: 'alice' }
    store.insert(COLLECTION, 'a', vec(0), fields)
    store.insert(COLLECTION, 'b', vec(10), fields)

    store.delete(COLLECTION, 'a')
    const hits = store.search(COLLECTION, vec(0), 10)
    expect(hits.map((h) => h.id)).toEqual(['b'])
  })

  it('fetches a single row by id', async () => {
    store = await loadStore()
    store.insert(COLLECTION, 'a', vec(0), {
      category: 'truth',
      scope: 'entities',
      source_id: 'alice',
    })
    expect(store.fetch(COLLECTION, 'a')?.fields.source_id).toBe('alice')
    expect(store.fetch(COLLECTION, 'nope')).toBeNull()
  })

  it('rebuilds the collection when the configured dimension changes', async () => {
    store = await loadStore(DIM)
    store.insert(COLLECTION, 'a', vec(0), {
      category: 'truth',
      scope: 'entities',
      source_id: 'alice',
    })
    expect(store.search(COLLECTION, vec(0), 5)).toHaveLength(1)
    store.close()

    // vec0 fixes the vector width in the table DDL, so a dimension change has
    // to drop and recreate. Old vectors are derived data and are simply lost.
    const wider = 16
    store = await loadStore(wider)
    expect(store.search(COLLECTION, vec(0, wider), 5)).toHaveLength(0)
    store.insert(COLLECTION, 'b', vec(0, wider), {
      category: 'truth',
      scope: 'entities',
      source_id: 'bob',
    })
    expect(store.search(COLLECTION, vec(0, wider), 5)).toHaveLength(1)
  })

  it('clear() wipes data but keeps the instance usable', async () => {
    store = await loadStore()
    const fields = { category: 'truth', scope: 'entities', source_id: 'alice' }
    store.insert(COLLECTION, 'a', vec(0), fields)
    expect(store.search(COLLECTION, vec(0), 5)).toHaveLength(1)

    store.clear()
    expect(store.search(COLLECTION, vec(0), 5)).toHaveLength(0)

    store.insert(COLLECTION, 'b', vec(0), fields)
    expect(store.search(COLLECTION, vec(0), 5)).toHaveLength(1)
  })
})
