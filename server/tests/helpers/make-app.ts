import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createApp } from '../../src/app.js'
import { SqliteStorage } from '../../src/storage/sqlite.js'
import { FakeRuntimeProvider, type FakeScript } from '@operon/agent-runtime'

export interface TestApp {
  storage: SqliteStorage
  workspaceId: number
  workspaceCwd: string
  request: (path: string, init?: RequestInit) => Promise<Response>
  cleanup: () => void
}

export async function makeTestApp(): Promise<TestApp> {
  FakeRuntimeProvider.resetScripts()
  const dir = mkdtempSync(path.join(tmpdir(), 'operon-test-'))
  const dbPath = path.join(dir, 'test.db')
  const workspaceCwd = mkdtempSync(path.join(tmpdir(), 'operon-test-cwd-'))
  const storage = new SqliteStorage(dbPath)

  const project = storage.createProject({ name: 'Test Project', rootPath: workspaceCwd })
  const workspace = storage.createWorkspace(project.id, {
    name: 'main',
    branchName: 'main',
    worktreePath: workspaceCwd,
  })

  const { app } = await createApp({ storage })
  return {
    storage,
    workspaceId: workspace.id,
    workspaceCwd,
    request: (reqPath, init) => app.request(reqPath, init),
    cleanup: () => {
      FakeRuntimeProvider.resetScripts()
      try {
        rmSync(dir, { recursive: true, force: true })
        rmSync(workspaceCwd, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

export function registerFakeScript(name: string, script: FakeScript): void {
  FakeRuntimeProvider.scripts.set(name, script)
  FakeRuntimeProvider.currentScript = name
}
