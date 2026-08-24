/**
 * MemoryService — singleton wrapper around MemoryEngine. Wires SQLite
 * (from SqliteStorage.getDatabase()) + the vector store into a single engine and
 * exposes it to routes, MCP, and the adapter tool layer.
 *
 * Entry point for the memory subsystem.
 */

import type Database from 'better-sqlite3'
import { SqliteVecStore } from '../vector/sqlite-vec-store.js'
import { MemoryEngine } from './engine.js'

export { MemoryEngine } from './engine.js'
export * from './types.js'
export { memorySearch } from './search/hybrid.js'
export {
  MEMORY_MCP_TOOLS,
  dispatchMemoryTool,
  execMemorySearch,
  execMemoryUpsert,
  type MemoryMcpTool,
} from './operations.js'

export class MemoryService {
  private static instance: MemoryService | null = null
  private readonly engine: MemoryEngine

  private constructor(db: Database.Database) {
    const vectors = SqliteVecStore.getInstance()
    this.engine = new MemoryEngine(db, vectors)
  }

  static init(db: Database.Database): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService(db)
    }
    return MemoryService.instance
  }

  static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      throw new Error('MemoryService not initialized. Call MemoryService.init(db) first.')
    }
    return MemoryService.instance
  }

  getEngine(): MemoryEngine {
    return this.engine
  }
}

