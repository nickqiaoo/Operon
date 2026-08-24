// Test server entrypoint used by Playwright's webServer.
//
// - Uses a fresh temp SQLite DB (cleaned on process exit).
// - Enables the Fake runtime provider via OPERON_ENABLE_FAKE_RUNTIME.
// - Forces memory off so we don't pull in embeddings/FTS infrastructure.
// - Skips telegram / cronjob scheduler side effects.
// - Mounts /api/test/* control routes that let Playwright specs reset state
//   between tests (clear DB tables, reset fake script registry).

export {}

// __ENABLE_MEMORY__ is normally baked in by vite's define; when running under
// tsx it's undefined. Declare it on globalThis BEFORE importing anything that
// references it.
;(globalThis as unknown as { __ENABLE_MEMORY__: boolean }).__ENABLE_MEMORY__ = false
process.env.OPERON_ENABLE_FAKE_RUNTIME = '1'
// Playwright drives the renderer in standalone-browser mode with no IPC channel
// to receive the api token; auth here would test fixture plumbing, not product.
process.env.OPERON_DISABLE_API_TOKEN = '1'

const { serve } = await import('@hono/node-server')
const fs = await import('fs')
const os = await import('os')
const path = await import('path')
const { SqliteStorage } = await import('./storage/sqlite.js')
const { createApp } = await import('./app.js')

interface SeedResult {
  projectId: number
  workspaceId: number
  workspaceCwd: string
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-test-server-'))
  const dbPath = path.join(dir, 'test.db')
  const storage = new SqliteStorage(dbPath)

  const seed = (): SeedResult => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-test-cwd-'))
    // Seed a couple of files so mention popup has something to suggest in tests.
    fs.writeFileSync(path.join(workspaceCwd, 'README.md'), '# Test workspace\n')
    fs.writeFileSync(path.join(workspaceCwd, 'index.ts'), 'export const hello = 1\n')
    fs.mkdirSync(path.join(workspaceCwd, 'src'))
    fs.writeFileSync(path.join(workspaceCwd, 'src', 'app.ts'), 'export const app = 2\n')
    const project = storage.createProject({ name: 'Test Project', rootPath: workspaceCwd })
    const workspace = storage.createWorkspace(project.id, {
      name: 'main',
      branchName: 'main',
      worktreePath: workspaceCwd,
    })
    return { projectId: project.id, workspaceId: workspace.id, workspaceCwd }
  }

  // Seed once on startup so the renderer can create chats immediately.
  // /api/test/db/reset will truncate + re-call this to refresh state.
  let lastSeed = seed()

  const reseed = (): SeedResult => {
    lastSeed = seed()
    return lastSeed
  }

  const { app } = await createApp({ storage, reseed })
  const port = Number(process.env.PORT ?? 4100)
  const hostname = process.env.HOST ?? '127.0.0.1'

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[test-server] listening on http://${hostname}:${info.port}`)
    console.log(`[test-server] seed workspace=${lastSeed.workspaceId} cwd=${lastSeed.workspaceCwd}`)
  })

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('exit', cleanup)
}

main().catch((err) => {
  console.error('[test-server] failed to start:', err)
  process.exit(1)
})
