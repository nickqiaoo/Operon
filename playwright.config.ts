import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const TEST_MODE = process.env.OPERON_TEST_MODE === 'real' ? 'real' : 'fake'
// Legacy: PLAYWRIGHT_CI=1 still implies fake mode. New code should set
// OPERON_TEST_MODE=fake (or omit, since fake is default).
const ENABLE_AUTOSTART = TEST_MODE === 'fake' && (process.env.PLAYWRIGHT_CI === '1' || process.env.CI === '1' || !process.env.OPERON_TEST_MODE_NO_AUTOSTART)
const CI_RENDERER_PORT = Number(process.env.PW_CI_RENDERER_PORT ?? 4101)
const CI_SERVER_PORT = Number(process.env.PW_CI_SERVER_PORT ?? 4100)

// The test server gets its own HOME. The server reads the machine's SaaS identity
// from ~/.operon/saas.json — not from its data dir — so under the real HOME it
// held the developer's node token: every approval or "waiting on you" a spec
// produced was pushed to their phone (no desktop-presence probe outside Electron,
// so nothing was held back), and a spec reaching sign-in or sign-out would
// rewrite their real SaaS config.
const TEST_SERVER_HOME = join(tmpdir(), 'operon-e2e-home')
mkdirSync(TEST_SERVER_HOME, { recursive: true })

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Legacy CDP project: real-only specs that exercise live provider CLIs.
      // Used by Layer-3 Agent exploration. Specs at e2e/*.spec.ts (excluding
      // e2e/specs/**) are the curated CDP suite.
      name: 'dev',
      testDir: './e2e',
      testIgnore: ['**/specs/**'],
    },
    {
      // Mode-aware feature suite. Specs at e2e/specs/**.
      // - OPERON_TEST_MODE=fake (default): Playwright self-hosts test-server
      //   (Fake Runtime) + vite renderer; runs against headless Chromium.
      // - OPERON_TEST_MODE=real: connects via CDP to your `pnpm dev` Electron
      //   instance. Specs that need deterministic events auto-skip via
      //   fakeOnly().
      // Tests share the test-server's global currentScript and DB state, so
      // we run with a single worker — parallelism would race.
      name: 'ci',
      testDir: './e2e/specs',
      fullyParallel: false,
      workers: 1,
      use: {
        baseURL: TEST_MODE === 'fake' ? `http://127.0.0.1:${CI_RENDERER_PORT}` : undefined,
      },
    },
  ],
  webServer: ENABLE_AUTOSTART
    ? [
        {
          command: 'npm run test-server',
          env: {
            PORT: String(CI_SERVER_PORT),
            HOST: '127.0.0.1',
            OPERON_ENABLE_FAKE_RUNTIME: '1',
            HOME: TEST_SERVER_HOME,
            // No ~/.gitconfig under that HOME: specs that commit still need an identity.
            GIT_AUTHOR_NAME: 'operon-e2e',
            GIT_AUTHOR_EMAIL: 'e2e@operon.invalid',
            GIT_COMMITTER_NAME: 'operon-e2e',
            GIT_COMMITTER_EMAIL: 'e2e@operon.invalid',
          },
          url: `http://127.0.0.1:${CI_SERVER_PORT}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'npm run test-renderer',
          url: `http://127.0.0.1:${CI_RENDERER_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ]
    : undefined,
})
