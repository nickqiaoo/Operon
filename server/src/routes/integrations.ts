import { Hono } from 'hono'
import {
  deleteGithubConfig,
  deleteLinearConfig,
  getGithubConfig,
  getLinearConfig,
  setGithubConfig,
  setLinearConfig,
} from '../services/integration-config.js'
import {
  createLinearIssue,
  fetchLinearTeamDetails,
  fetchLinearTeams,
  fetchLinearViewer,
} from '../services/integrations/linear.js'
import {
  createGithubPR,
  fetchGithubRepo,
  fetchGithubViewer,
  parseGithubRemote,
} from '../services/integrations/github.js'
import * as gitService from '../services/git.js'

export function integrationsRoutes() {
  const router = new Hono()

  router.get('/linear', (c) => {
    const config = getLinearConfig()
    if (!config) {
      return c.json({ configured: false, apiKey: '', workspaceName: '' })
    }
    return c.json({
      configured: true,
      apiKey: config.apiKey,
      workspaceName: config.workspaceName,
    })
  })

  router.put('/linear', async (c) => {
    const body = await c.req.json<{ apiKey?: string }>()
    const apiKey = body.apiKey?.trim() ?? ''
    if (!apiKey) {
      return c.json({ error: 'apiKey is required' }, 400)
    }

    try {
      const viewer = await fetchLinearViewer(apiKey)
      setLinearConfig({ apiKey, workspaceName: viewer.workspaceName })
      return c.json({
        configured: true,
        apiKey,
        workspaceName: viewer.workspaceName,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to validate Linear API key'
      return c.json({ error: message }, 400)
    }
  })

  router.delete('/linear', (c) => {
    deleteLinearConfig()
    return c.json({ success: true })
  })

  router.get('/linear/teams', async (c) => {
    const config = getLinearConfig()
    if (!config) {
      return c.json({ error: 'Linear is not configured' }, 400)
    }
    try {
      const teams = await fetchLinearTeams(config.apiKey)
      return c.json({ teams })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch teams'
      return c.json({ error: message }, 500)
    }
  })

  router.get('/linear/teams/:teamId', async (c) => {
    const config = getLinearConfig()
    if (!config) {
      return c.json({ error: 'Linear is not configured' }, 400)
    }
    const teamId = c.req.param('teamId')
    try {
      const details = await fetchLinearTeamDetails(config.apiKey, teamId)
      return c.json(details)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch team details'
      return c.json({ error: message }, 500)
    }
  })

  router.get('/github', (c) => {
    const config = getGithubConfig()
    if (!config) {
      return c.json({ configured: false, token: '', login: '' })
    }
    return c.json({ configured: true, token: config.token, login: config.login })
  })

  router.put('/github', async (c) => {
    const body = await c.req.json<{ token?: string }>()
    const token = body.token?.trim() ?? ''
    if (!token) {
      return c.json({ error: 'token is required' }, 400)
    }
    try {
      const viewer = await fetchGithubViewer(token)
      setGithubConfig({ token, login: viewer.login })
      return c.json({ configured: true, token, login: viewer.login })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to validate GitHub token'
      return c.json({ error: message }, 400)
    }
  })

  router.delete('/github', (c) => {
    deleteGithubConfig()
    return c.json({ success: true })
  })

  router.post('/github/repo-status', async (c) => {
    const config = getGithubConfig()
    if (!config) {
      return c.json({ error: 'GitHub is not configured' }, 400)
    }
    const { repoPath } = await c.req.json<{ repoPath: string }>()
    if (!repoPath) return c.json({ error: 'repoPath is required' }, 400)

    // The git calls below shell out and throw on a path that has gone away —
    // a stale worktree the caller still has open is enough. Only the GitHub
    // fetch used to be guarded, so those threw out of the handler and became a
    // bodyless 500 that said nothing about which step failed.
    try {
      const isRepo = await gitService.isGitRepo(repoPath)
      if (!isRepo) return c.json({ isRepo: false })

      const remotes = await gitService.listRemotes(repoPath)
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0]
      const parsed = origin ? parseGithubRemote(origin.url) : null

      const status = await gitService.getStatus(repoPath)
      const currentBranch = status.current

      let defaultBranch: string | null = null
      if (parsed) {
        try {
          const repoInfo = await fetchGithubRepo(config.token, parsed.owner, parsed.repo)
          defaultBranch = repoInfo.defaultBranch
        } catch {
          defaultBranch = null
        }
      }

      return c.json({
        isRepo: true,
        remoteName: origin?.name ?? null,
        owner: parsed?.owner ?? null,
        repo: parsed?.repo ?? null,
        currentBranch,
        defaultBranch,
        ahead: status.ahead,
        behind: status.behind,
        stagedCount: status.staged.length,
        unstagedCount: status.unstaged.length,
        untrackedCount: status.untracked.length,
        changedFiles: status.files.map((f) => f.path),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[integrations] repo-status failed for ${repoPath}:`, message)
      return c.json({ error: message }, 500)
    }
  })

  router.post('/github/create-pr', async (c) => {
    const config = getGithubConfig()
    if (!config) return c.json({ error: 'GitHub is not configured' }, 400)

    const body = await c.req.json<{
      repoPath?: string
      title?: string
      body?: string
      branchName?: string
      baseBranch?: string
      commitMessage?: string
      draft?: boolean
      remote?: string
    }>()

    const { repoPath, title, baseBranch, branchName } = body
    if (!repoPath || !title || !baseBranch || !branchName) {
      return c.json({ error: 'repoPath, title, branchName, baseBranch are required' }, 400)
    }

    const remotes = await gitService.listRemotes(repoPath)
    const originRemote =
      remotes.find((r) => r.name === (body.remote ?? 'origin')) ?? remotes[0]
    if (!originRemote) {
      return c.json({ error: 'No git remote configured' }, 400)
    }
    const parsed = parseGithubRemote(originRemote.url)
    if (!parsed) {
      return c.json({ error: `Remote ${originRemote.url} is not a GitHub repo` }, 400)
    }

    try {
      const currentBranch = await gitService.getCurrentBranch(repoPath)

      if (currentBranch === baseBranch || branchName !== currentBranch) {
        const exists = await gitService.localBranchExists(repoPath, branchName)
        if (exists) {
          return c.json(
            { error: `Branch ${branchName} already exists locally. Pick a different name.` },
            400,
          )
        }
        await gitService.checkoutNewBranch(repoPath, branchName)
      }

      const status = await gitService.getStatus(repoPath)
      const hasChanges =
        status.staged.length + status.unstaged.length + status.untracked.length > 0
      if (hasChanges) {
        if (!body.commitMessage) {
          return c.json({ error: 'commitMessage is required for uncommitted changes' }, 400)
        }
        await gitService.stageAll(repoPath)
        await gitService.commit(repoPath, body.commitMessage)
      }

      await gitService.pushBranch(repoPath, originRemote.name, branchName, true)

      const pr = await createGithubPR(config.token, {
        owner: parsed.owner,
        repo: parsed.repo,
        title,
        body: body.body ?? '',
        head: branchName,
        base: baseBranch,
        draft: body.draft ?? false,
      })

      return c.json({ pr })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create PR'
      return c.json({ error: message }, 500)
    }
  })

  router.post('/linear/issues', async (c) => {
    const config = getLinearConfig()
    if (!config) {
      return c.json({ error: 'Linear is not configured' }, 400)
    }

    const body = await c.req.json<{
      teamId?: string
      title?: string
      description?: string
      projectId?: string
      priority?: number
      labelIds?: string[]
    }>()

    if (!body.teamId || !body.title) {
      return c.json({ error: 'teamId and title are required' }, 400)
    }

    try {
      const issue = await createLinearIssue(config.apiKey, {
        teamId: body.teamId,
        title: body.title,
        description: body.description,
        projectId: body.projectId,
        priority: body.priority,
        labelIds: body.labelIds,
      })
      return c.json({ issue })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create issue'
      return c.json({ error: message }, 500)
    }
  })

  return router
}
