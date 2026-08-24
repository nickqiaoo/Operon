/**
 * SqliteVecStore — vector storage backed by SQLite + the `sqlite-vec` loadable
 * extension (vec0 virtual tables).
 *
 * Replaces the previous `@zvec/zvec` store. The motivation was platform reach:
 * zvec only publishes prebuilt bindings for darwin-arm64 / linux-arm64 /
 * linux-x64, which forced `ENABLE_MEMORY=false` on the Intel Mac build and left
 * Windows unreachable entirely. sqlite-vec ships darwin-x64, darwin-arm64,
 * linux-x64, linux-arm64 and windows-x64.
 *
 * The retrieval algorithm is unchanged. zvec was configured with
 * `ZVecIndexType.FLAT` — brute-force exact KNN, not ANN — and vec0 is likewise
 * brute-force exact. Cosine distances are numerically identical between the two
 * (same direction = 0, orthogonal = 1, opposite = 2, both normalise magnitude),
 * so the tuned thresholds downstream (`hybrid.ts` maxVectorDistance = 0.6,
 * `operations.ts` RECONCILE_DISTANCE = 0.35) carry over untouched.
 *
 * There is no migration path from the old store, and none is needed: vectors
 * are derived data (FTS stays authoritative, see engine.ts), so a store that
 * starts empty simply refills itself on subsequent upserts.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { getEmbeddingConfig } from './embeddings.js'

// `sqlite-vec` is an optionalDependency and is required lazily, mirroring how
// `local-llm.ts` handles `node-llama-cpp`: headless deploys install with
// `--omit=optional` and must still be able to import this module.
type SqliteVecModule = typeof import('sqlite-vec')
let sqliteVecModule: SqliteVecModule | null = null

function sqliteVec(): SqliteVecModule {
  if (!sqliteVecModule) {
    sqliteVecModule = createRequire(import.meta.url)('sqlite-vec') as SqliteVecModule
  }
  return sqliteVecModule
}

// Sandboxable vector root. Defaults to ~/.operon/vector (unchanged behaviour);
// set OPERON_VECTOR_DIR to relocate it (e.g. benchmark/eval runs that must not
// touch the user's real vector store). Mirrors OPERON_DATA_DIR for SQLite.
const VECTOR_DIR = process.env.OPERON_VECTOR_DIR || path.join(os.homedir(), '.operon', 'vector')

/** Each collection is its own database file; this is the table inside it. */
const TABLE = 'memory_vec'

export interface SearchResult {
  id: string
  score: number
  fields: Record<string, unknown>
}

/**
 * Structured search filter.
 *
 * Deliberately not a free-form expression string. vec0 only pushes a
 * conjunction of simple comparisons (`=`, `!=`, `<`, `<=`, `>`, `>=`, `IN`) on
 * metadata columns down into the KNN scan. A cross-column `OR` or a `NOT IN`
 * does *not* error — it silently degrades into a post-filter over the global
 * top-k, which quietly returns fewer rows than asked for. Restricting the
 * caller to this shape makes that class of bug unrepresentable.
 *
 * An empty or omitted field means "no constraint on that column".
 */
export interface VectorFilter {
  category?: string
  scope?: string | string[]
}

const DEFAULT_EMBEDDING_DIMENSIONS = 1024

function getConfiguredDimensions(): number {
  const config = getEmbeddingConfig()
  return config.dimensions || DEFAULT_EMBEDDING_DIMENSIONS
}

/** SQLite writes two sidecar files in WAL mode; all three must go together. */
function removeDatabaseFiles(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(p, { force: true })
  }
}

interface Collection {
  db: Database.Database
  insert: Database.Statement
  remove: Database.Statement
  fetchOne: Database.Statement
}

export class SqliteVecStore {
  private static instance: SqliteVecStore | null = null
  private collections = new Map<string, Collection>()

  private constructor() {
    fs.mkdirSync(VECTOR_DIR, { recursive: true })
  }

  static init(): SqliteVecStore {
    if (!SqliteVecStore.instance) {
      SqliteVecStore.instance = new SqliteVecStore()
    }
    return SqliteVecStore.instance
  }

  static getInstance(): SqliteVecStore | null {
    return SqliteVecStore.instance
  }

  private dbPath(collection: string): string {
    return path.join(VECTOR_DIR, `${collection}.db`)
  }

  private openDatabase(dbPath: string): Database.Database {
    const db = new Database(dbPath)
    // loadExtension goes through the OS loader, not Node's module resolution,
    // so an asar-internal path cannot be dlopen'd. electron-builder unpacks
    // `node_modules/sqlite-vec-*/**` and this rewrites the path to that copy.
    const loadable = sqliteVec()
      .getLoadablePath()
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    db.loadExtension(loadable)
    db.pragma('journal_mode = WAL')
    return db
  }

  private createSchema(db: Database.Database, dimension: number): void {
    // `category` / `scope` are metadata columns (filterable, pushed into the
    // KNN scan); `source_id` is auxiliary (`+`), returned but never filtered —
    // filtering an auxiliary column is a hard error in vec0.
    db.exec(`
      CREATE VIRTUAL TABLE ${TABLE} USING vec0(
        id         TEXT PRIMARY KEY,
        embedding  FLOAT[${dimension}] distance_metric=cosine,
        category   TEXT,
        scope      TEXT,
        +source_id TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `)
    db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(
      'dimension',
      String(dimension),
    )
  }

  private storedDimension(db: Database.Database): number | null {
    try {
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('dimension') as
        | { v: string }
        | undefined
      const parsed = row ? Number(row.v) : NaN
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null
    } catch {
      // `meta` missing => pre-schema or corrupt file; treat as "unknown".
      return null
    }
  }

  private getOrCreateCollection(collection: string): Collection {
    const existing = this.collections.get(collection)
    if (existing) return existing

    const dbPath = this.dbPath(collection)
    const dimension = getConfiguredDimensions()

    let db = this.openDatabase(dbPath)
    const stored = this.storedDimension(db)

    if (stored === null) {
      this.createSchema(db, dimension)
    } else if (stored !== dimension) {
      // vec0 fixes the vector width in the table definition, so a dimension
      // change means rebuilding. The vectors are derived data — the next upsert
      // re-embeds from the FTS-authoritative truth.
      console.warn(
        `[SqliteVecStore] Dimension mismatch for "${collection}" (stored=${stored}, configured=${dimension}), recreating`,
      )
      db.close()
      removeDatabaseFiles(dbPath)
      db = this.openDatabase(dbPath)
      this.createSchema(db, dimension)
    }

    const entry: Collection = {
      db,
      insert: db.prepare(
        `INSERT INTO ${TABLE}(id, embedding, category, scope, source_id) VALUES (?, ?, ?, ?, ?)`,
      ),
      remove: db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`),
      fetchOne: db.prepare(`SELECT id, category, scope, source_id FROM ${TABLE} WHERE id = ?`),
    }
    this.collections.set(collection, entry)
    return entry
  }

  /**
   * Build the `AND …` tail of a KNN query. Only equality and `IN` are emitted,
   * both of which vec0 pushes into the scan (verified empirically).
   */
  private buildFilter(filter?: VectorFilter): { sql: string; params: string[] } {
    const clauses: string[] = []
    const params: string[] = []

    if (filter?.category) {
      clauses.push('category = ?')
      params.push(filter.category)
    }

    const scope = filter?.scope
    if (typeof scope === 'string' && scope) {
      clauses.push('scope = ?')
      params.push(scope)
    } else if (Array.isArray(scope) && scope.length > 0) {
      clauses.push(`scope IN (${scope.map(() => '?').join(', ')})`)
      params.push(...scope)
    }

    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params }
  }

  insert(
    collection: string,
    id: string,
    embedding: number[],
    fields: Record<string, string>,
  ): void {
    try {
      const col = this.getOrCreateCollection(collection)
      const vector = Buffer.from(new Float32Array(embedding).buffer)
      // vec0 rejects both a duplicate INSERT and `INSERT OR REPLACE` on a text
      // primary key, so upsert is delete-then-insert inside one transaction.
      col.db.transaction(() => {
        col.remove.run(id)
        col.insert.run(
          id,
          vector,
          fields.category ?? '',
          fields.scope ?? '',
          fields.source_id ?? '',
        )
      })()
    } catch (err) {
      console.warn('[SqliteVecStore] Insert error:', err)
    }
  }

  search(
    collection: string,
    queryVector: number[],
    topK: number = 10,
    filter?: VectorFilter,
  ): SearchResult[] {
    try {
      const col = this.getOrCreateCollection(collection)
      const { sql, params } = this.buildFilter(filter)
      const rows = col.db
        .prepare(
          `SELECT id, distance, category, scope, source_id FROM ${TABLE}
           WHERE embedding MATCH ? AND k = ?${sql}
           ORDER BY distance`,
        )
        .all(Buffer.from(new Float32Array(queryVector).buffer), topK, ...params) as {
        id: string
        distance: number
        category: string
        scope: string
        source_id: string
      }[]

      return rows.map((r) => ({
        id: r.id,
        // `distance` keeps zvec's convention: cosine distance, lower is better.
        score: r.distance,
        fields: { category: r.category, scope: r.scope, source_id: r.source_id },
      }))
    } catch (err) {
      console.warn('[SqliteVecStore] Search error:', err)
      return []
    }
  }

  delete(collection: string, id: string): void {
    try {
      this.getOrCreateCollection(collection).remove.run(id)
    } catch (err) {
      console.warn('[SqliteVecStore] Delete error:', err)
    }
  }

  fetch(collection: string, id: string): SearchResult | null {
    try {
      const row = this.getOrCreateCollection(collection).fetchOne.get(id) as
        | { id: string; category: string; scope: string; source_id: string }
        | undefined
      if (!row) return null
      return {
        id: row.id,
        score: 0,
        fields: { category: row.category, scope: row.scope, source_id: row.source_id },
      }
    } catch (err) {
      console.warn('[SqliteVecStore] Fetch error:', err)
      return null
    }
  }

  /**
   * Wipe all vector data in place: close every open collection, forget them,
   * and delete their on-disk storage so the next insert recreates them empty.
   * Unlike close(), this keeps the singleton alive — callers holding this
   * instance (e.g. a MemoryEngine) stay valid. Used to reset a sandbox between
   * benchmark conversations when the store has no per-user scoping.
   */
  clear(): void {
    for (const [name, col] of this.collections) {
      try {
        col.db.close()
      } catch {
        // ignore
      }
      removeDatabaseFiles(this.dbPath(name))
    }
    this.collections.clear()
    try {
      for (const entry of fs.readdirSync(VECTOR_DIR)) {
        if (entry.endsWith('.db') || entry.endsWith('.db-wal') || entry.endsWith('.db-shm')) {
          fs.rmSync(path.join(VECTOR_DIR, entry), { force: true })
        }
      }
    } catch {
      // VECTOR_DIR may not exist yet — nothing to wipe
    }
  }

  close(): void {
    for (const col of this.collections.values()) {
      try {
        col.db.close()
      } catch {
        // ignore
      }
    }
    this.collections.clear()
    SqliteVecStore.instance = null
  }
}