import { test as base, expect, type Page, chromium } from '@playwright/test'

/**
 * Mode-aware unified fixture for `e2e/specs/*.spec.ts`.
 *
 * Two run modes, switched via `OPERON_TEST_MODE`:
 *
 *   • `fake` (default) — Playwright auto-starts test-server (:4100) + vite
 *     renderer (:4101). Uses a headless Chromium. Fake runtime drives all
 *     stream events. Deterministic, fast, free.
 *
 *   • `real`            — Connects via CDP (port 9223 by default) to your
 *     running Electron dev instance (`pnpm dev`). Real provider CLIs and
 *     real DB are exercised. `setFakeScript` / `resetServerState` become
 *     no-ops. Use for sanity-checking real integration locally.
 *
 * Per-spec mode gating: call `fakeOnly()` / `realOnly()` at the top of a
 * test body to skip the spec when the mode doesn't match.
 */

export type TestMode = 'fake' | 'real'
export const TEST_MODE: TestMode =
  (process.env.OPERON_TEST_MODE as TestMode) === 'real' ? 'real' : 'fake'

const SERVER_PORT = Number(process.env.PW_CI_SERVER_PORT ?? 4100)
const CDP_PORT = process.env.CDP_PORT ?? '9223'

type OperonProbeShape = {
  activeTabId: () => string
  activeChatId: () => number | undefined
  tabs: () => Array<{
    id: string
    chatId?: number
    providerId?: string
    title?: string
    type?: string
    options?: Record<string, unknown>
  }>
  streamState: () => 'idle' | 'streaming'
  streamingTabIds: () => string[]
  unseenTabIds?: () => string[]
  tabState?: (tabId: string) => unknown
  workspace?: () => { projectId: number | null; workspaceId: number | null }
  notifications?: () => Array<{ id: string; type: string; message: string }>
  messageCount?: () => number
  pendingApprovals?: () => number
  panels?: () => { right: ProbePanel; bottom: ProbePanel }
  project?: () => {
    activeProjectId: number | null
    activeWorkspaceId: number | null
    projectCount: number
    workspaceCount: number
  }
}

type ProbePanel = {
  open: boolean
  expanded: boolean
  activeTabId: string | null
  tabs: Array<{ tabId: string; type: string; title: string }>
}

declare global {
  interface Window {
    __operon?: OperonProbeShape
    __OPERON_SERVER_PORT__?: number
  }
}

/**
 * Page fixture.
 *
 * - In fake mode: configures the renderer to point at the test server and
 *   resets DB + fake script registry before navigation.
 * - In real mode: connects to the running Electron via CDP and reuses its
 *   open page. State is NOT reset — it's the user's real workspace.
 */
export const test = base.extend<{ page: Page; mode: TestMode }>({
  mode: [TEST_MODE, { option: true }],
  page: async ({ page: rawPage, playwright: _playwright }, use) => {
    if (TEST_MODE === 'real') {
      let versionRes: Response
      try {
        versionRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      } catch (err) {
        throw new Error(
          `Cannot connect to CDP on port ${CDP_PORT}. Run \`pnpm dev\` first ` +
          `(or set CDP_PORT to your dev instance's debug port). ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!versionRes.ok) {
        throw new Error(
          `CDP responded with ${versionRes.status} on port ${CDP_PORT}. ` +
          `Verify your dev instance has remote debugging enabled.`,
        )
      }
      const { webSocketDebuggerUrl } = (await versionRes.json()) as { webSocketDebuggerUrl: string }
      const browser = await chromium.connectOverCDP(webSocketDebuggerUrl)
      const ctx = browser.contexts()[0]
      if (!ctx) throw new Error('No browser context found in Electron')
      const pages = ctx.pages()
      const electronPage = pages.find((p) => p.url().includes('localhost')) ?? pages[0]
      if (!electronPage) throw new Error('No page found in the Electron window')

      // Real mode: don't reset state, don't navigate — use the user's app as-is.
      await use(electronPage)
      // Don't close — it's the user's running Electron.
      return
    }

    // fake mode
    await rawPage.addInitScript((port: number) => {
      window.__OPERON_SERVER_PORT__ = port
    }, SERVER_PORT)

    await resetServerState()
    await rawPage.goto('/')
    await expect
      .poll(() => rawPage.evaluate(() => Boolean(window.__operon)), {
        message: 'window.__operon probe was not installed',
        timeout: 10_000,
      })
      .toBe(true)

    await use(rawPage)
  },
})

export { expect }

// ───────────────────────────── Mode gating ────────────────────────────────

/**
 * Skip the current test if not running in fake mode.
 * Call inside the test body, before the rest of the spec runs.
 */
export function fakeOnly(reason = 'fake-mode only — needs deterministic events'): void {
  test.skip(TEST_MODE !== 'fake', reason)
}

/**
 * Skip the current test if not running in real mode.
 * Call inside the test body, before the rest of the spec runs.
 */
export function realOnly(reason = 'real-mode only — exercises real Electron / provider'): void {
  test.skip(TEST_MODE !== 'real', reason)
}

// ───────────────────────────── Test-server helpers ────────────────────────
// These are no-ops in real mode (real Electron has no /api/test/* routes).

async function fetchTestServer(path: string, init?: RequestInit): Promise<Response> {
  const url = `http://127.0.0.1:${SERVER_PORT}${path}`
  return fetch(url, init)
}

/** Reset DB + fake script registry. No-op in real mode. */
export async function resetServerState(): Promise<void> {
  if (TEST_MODE !== 'fake') return
  const dbRes = await fetchTestServer('/api/test/db/reset', { method: 'POST' })
  if (!dbRes.ok) throw new Error(`db/reset failed: ${dbRes.status}`)
  const fakeRes = await fetchTestServer('/api/test/fake/reset', { method: 'POST' })
  if (!fakeRes.ok) throw new Error(`fake/reset failed: ${fakeRes.status}`)
}

/** Switch the active fake script. No-op in real mode. */
export async function setFakeScript(name: string): Promise<void> {
  if (TEST_MODE !== 'fake') return
  const res = await fetchTestServer('/api/test/fake/script', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`setFakeScript(${name}) failed: ${res.status} ${body}`)
  }
}

/** List available fake scripts. Throws in real mode. */
export async function listFakeScripts(): Promise<{ scripts: string[]; current: string }> {
  if (TEST_MODE !== 'fake') {
    throw new Error('listFakeScripts() is fake-mode only')
  }
  const res = await fetchTestServer('/api/test/fake/scripts')
  if (!res.ok) throw new Error(`scripts list failed: ${res.status}`)
  return (await res.json()) as { scripts: string[]; current: string }
}

// ───────────────────────────── UI helpers (mode-agnostic) ─────────────────

/** Wait until the active streaming tab returns to idle. */
export async function waitForStreamIdle(page: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__operon?.streamState() ?? 'idle'), { timeout })
    .toBe('idle')
}

/** Wait for a tool-call DOM node with the given tool name to appear. */
export async function waitForToolCall(
  page: Page,
  toolName: string,
  timeout = 10_000,
): Promise<void> {
  await expect(page.locator(`[data-testid="tool-name"]:has-text("${toolName}")`).first()).toBeVisible({
    timeout,
  })
}

export type PermissionOutcome = 'allow' | 'allow-always' | 'deny'

/** Click the matching permission button. Asserts the dialog was visible first. */
export async function approvePermission(
  page: Page,
  outcome: PermissionOutcome = 'allow',
): Promise<void> {
  const dialog = page.locator('[data-testid="permission-dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const btnTestId = outcome === 'deny' ? 'permission-reject-deny' : `permission-allow-${outcome}`
  const specific = dialog.locator(`[data-testid="${btnTestId}"]`)
  if ((await specific.count()) > 0) {
    await specific.first().click()
    return
  }
  const generic = dialog.locator(
    outcome === 'deny'
      ? '[data-testid^="permission-reject-"]'
      : '[data-testid^="permission-allow-"]',
  )
  await generic.first().click()
}

/** Wait until at least one assistant message is rendered. */
export async function waitForAssistantMessage(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({ timeout })
}

/** Returns the count of messages in the active tab via the probe's DOM scan. */
export async function getMessageCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__operon?.messageCount?.() ?? 0)
}
