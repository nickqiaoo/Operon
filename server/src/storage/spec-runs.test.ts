import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'
import type { SpecRunConfig } from '../types/spec.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-spec-runs-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

const config: SpecRunConfig = {
  lead: { providerId: 'codex' },
  explorer: { providerId: 'codex' },
  candidates: [{ providerId: 'codex' }, { providerId: 'opencode' }],
  judge: { providerId: 'opencode' },
  builder: { providerId: 'opencode' },
}

describe.skipIf(!opened)('spec runs', () => {
  it('keeps every workflow run a spec has had, oldest first', () => {
    storage.specRunCreate({ taskId: 1, stage: 'grounding', config })
    expect(storage.specRunGet(1)?.runIds).toEqual([])

    storage.specRunUpdate(1, { workflowRunId: 'spec-a' })
    storage.specRunUpdate(1, { stage: 'stopped' })
    const run = storage.specRunUpdate(1, { workflowRunId: 'spec-b', error: null })

    expect(run?.workflowRunId).toBe('spec-b')
    expect(run?.runIds).toEqual(['spec-a', 'spec-b'])

    // A continued run is the same entry, not a new one.
    expect(storage.specRunUpdate(1, { workflowRunId: 'spec-b' })?.runIds).toEqual(['spec-a', 'spec-b'])
  })
})
