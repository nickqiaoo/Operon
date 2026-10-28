import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRoutes } from './git.js'

vi.mock('../services/git-commit-message.js', () => ({ generateCommitMessage: vi.fn() }))
vi.mock('../services/git-pr-summary.js', () => ({ generatePrSummary: vi.fn() }))

describe('Git route errors', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'operon-git-route-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns an unavailable response without passing it to the server error logger', async () => {
    const unexpected = vi.fn()
    const app = new Hono()
    app.onError((error, c) => {
      unexpected(error)
      return c.json({ error: error.message }, 500)
    })
    app.route('/git', gitRoutes())
    const response = await app.request('/git/diff-range', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: join(root, 'missing'), baseRef: 'HEAD' }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'Workspace directory is unavailable', code: 'WORKSPACE_UNAVAILABLE',
    })
    expect(unexpected).not.toHaveBeenCalled()

    execFileSync('git', ['init', '-q'], { cwd: root })
    const invalidRef = await app.request('/git/diff-range', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: root, baseRef: 'missing-ref' }),
    })
    expect(invalidRef.status).toBe(500)
    expect(unexpected).toHaveBeenCalledOnce()
  })
})
