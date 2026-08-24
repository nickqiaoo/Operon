import { Hono } from 'hono'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as gitService from '../services/git.js'
import { generateCommitMessage } from '../services/git-commit-message.js'
import { worktreePathFor } from '../services/worktree-paths.js'

export function gitRoutes() {
  const router = new Hono()

  router.post('/status', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.getStatus(repoPath)
    return c.json(result)
  })

  router.post('/diff', async (c) => {
    const { repoPath, file, cached } = await c.req.json<{
      repoPath: string
      file?: string
      cached?: boolean
    }>()
    const result = await gitService.getDiff(repoPath, file, cached)
    return c.json({ diff: result })
  })

  router.post('/show', async (c) => {
    const { repoPath, ref, file } = await c.req.json<{
      repoPath: string
      ref: string
      file: string
    }>()
    const content = await gitService.gitShow(repoPath, ref, file)
    return c.json({ content })
  })

  router.post('/stage', async (c) => {
    const { repoPath, filePath } = await c.req.json<{ repoPath: string; filePath: string }>()
    await gitService.stage(repoPath, filePath)
    return c.json({ success: true })
  })

  router.post('/stage-all', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    await gitService.stageAll(repoPath)
    return c.json({ success: true })
  })

  router.post('/unstage', async (c) => {
    const { repoPath, filePath } = await c.req.json<{ repoPath: string; filePath: string }>()
    await gitService.unstage(repoPath, filePath)
    return c.json({ success: true })
  })

  router.post('/unstage-all', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    await gitService.unstageAll(repoPath)
    return c.json({ success: true })
  })

  router.post('/worktree/list', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.worktreeList(repoPath)
    return c.json(result)
  })

  router.post('/worktree/add', async (c) => {
    const { repoPath, path, branch, createBranch, source, projectId, name } = await c.req.json<{
      repoPath: string
      path?: string
      branch: string
      createBranch?: boolean
      source?: string
      // When projectId + name are provided, the worktree path is derived from
      // operon's managed worktrees dir (~/.operon/worktrees/<id>-<repo>/<name>)
      // instead of an explicit `path`, keeping manual workspaces consistent with
      // agent/Linear-provisioned ones.
      projectId?: number
      name?: string
    }>()
    const worktreePath =
      projectId != null && name ? worktreePathFor(projectId, repoPath, name) : path
    if (!worktreePath) {
      return c.json({ success: false, error: 'worktree path required' }, 400)
    }
    // git worktree add won't create missing parent dirs — ensure they exist.
    await mkdir(dirname(worktreePath), { recursive: true })
    await gitService.worktreeAdd(repoPath, worktreePath, branch, createBranch, source)
    return c.json({ success: true, path: worktreePath })
  })

  router.post('/worktree/remove', async (c) => {
    const { repoPath, path, force } = await c.req.json<{
      repoPath: string
      path: string
      force?: boolean
    }>()
    await gitService.worktreeRemove(repoPath, path, force)
    return c.json({ success: true })
  })

  router.post('/diff-stat', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.getDiffStat(repoPath)
    return c.json(result)
  })

  router.post('/status-with-diff-stat', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.getStatusWithDiffStat(repoPath)
    return c.json(result)
  })

  router.post('/remotes', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.listRemotes(repoPath)
    return c.json(result)
  })

  router.post('/commit', async (c) => {
    const { repoPath, message, includeUnstaged } = await c.req.json<{
      repoPath: string
      message: string
      includeUnstaged?: boolean
    }>()
    const commitHash = await gitService.commit(repoPath, message, { includeUnstaged })
    return c.json({ success: true, commit: commitHash })
  })

  router.post('/push-status', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const result = await gitService.getPushStatus(repoPath)
    return c.json(result)
  })

  router.post('/push', async (c) => {
    const { repoPath, setUpstream, force } = await c.req.json<{
      repoPath: string
      setUpstream?: boolean
      force?: boolean
    }>()
    // Always 200 with a result object so the client can branch on `code`
    // (the shared request helper throws on non-2xx, hiding the error code).
    try {
      await gitService.push(repoPath, { setUpstream, force })
      return c.json({ success: true, code: null as string | null, error: null as string | null })
    } catch (e) {
      const code = e instanceof gitService.PushError ? e.code : 'unknown'
      return c.json({ success: false, code, error: e instanceof Error ? e.message : 'Push failed' })
    }
  })

  router.post('/generate-commit-message', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    try {
      const message = await generateCommitMessage(repoPath)
      return c.json({ message })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Generation failed' }, 500)
    }
  })

  router.post('/branches', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const branches = await gitService.listBranches(repoPath)
    return c.json({ branches })
  })

  router.post('/commits', async (c) => {
    const { repoPath, limit } = await c.req.json<{ repoPath: string; limit?: number }>()
    const commits = await gitService.listCommits(repoPath, limit)
    return c.json({ commits })
  })

  router.post('/default-base-branch', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    const base = await gitService.getDefaultBaseBranch(repoPath)
    return c.json({ base })
  })

  router.post('/merge-base', async (c) => {
    const { repoPath, ref } = await c.req.json<{ repoPath: string; ref: string }>()
    const mergeBase = await gitService.getMergeBase(repoPath, ref)
    return c.json({ mergeBase })
  })

  router.post('/commit-parent', async (c) => {
    const { repoPath, sha } = await c.req.json<{ repoPath: string; sha: string }>()
    const parent = await gitService.getCommitParentSha(repoPath, sha)
    return c.json({ parent })
  })

  router.post('/diff-range', async (c) => {
    const { repoPath, baseRef, headRef } = await c.req.json<{
      repoPath: string
      baseRef: string
      headRef?: string | null
    }>()
    const files = await gitService.getDiffRange(repoPath, baseRef, headRef ?? null)
    return c.json({ files })
  })

  router.post('/file-diff-range', async (c) => {
    const { repoPath, file, baseRef, headRef } = await c.req.json<{
      repoPath: string
      file?: string
      baseRef: string
      headRef?: string | null
    }>()
    const diff = await gitService.getFileDiffRange(repoPath, file, baseRef, headRef ?? null)
    return c.json({ diff })
  })

  router.post('/restore', async (c) => {
    const { repoPath, filePath } = await c.req.json<{ repoPath: string; filePath: string }>()
    await gitService.restore(repoPath, filePath)
    return c.json({ success: true })
  })

  router.post('/restore-all', async (c) => {
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    await gitService.restoreAll(repoPath)
    return c.json({ success: true })
  })

  return router
}
