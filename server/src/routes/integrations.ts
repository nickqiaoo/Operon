import { Hono } from 'hono'
import {
  deleteLinearAppConfig,
  getLinearAppConfig,
  getLinearDelegationConfig,
  getLinearPublishTeam,
  setLinearAppConfig,
  setLinearDelegationConfig,
} from '../services/integration-config.js'
import {
  createLinearIssue,
  fetchLinearTeamDetails,
  fetchLinearTeams,
} from '../services/integrations/linear-app.js'
import { parseGithubRemote } from '../services/integrations/github.js'
import {
  getGhStatus,
  ghPrCreate,
  ghPrForBranch,
} from '../services/integrations/gh-cli.js'
import {
  BrokerError,
  fetchIntegrationsStatus,
  forgetGithubInstallation,
  isBrokerConnected,
  uninstallLinear,
  unlinkLinear,
  type IntegrationsStatus,
} from '../services/integrations/broker-client.js'
import { beginIntegrationFlow, type IntegrationFlowKind } from '../gateway/saas/integration-flow.js'
import { forgetInstallationCache, installationFor, parseRepoFull } from '../services/integrations/github-app.js'
import { claimRoute, repoOfProject } from '../services/integrations/project-repos.js'
import { surfaceEventsRoutes } from '../gateway/surfaces/route.js'
import { publishTaskToLinear } from '../gateway/surfaces/surface-sync.js'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../storage/interface.js'
import * as gitService from '../services/git.js'

// Linear × GitHub integration, desktop side (docs/linear-github/design.md §4,
// §13). The broker owns the Apps and their tokens; this router drives the
// install / link flows from Settings, keeps the one local default (which
// agent runs Linear delegations), and calls Linear through the broker proxy.
// The GitHub personal-token routes below are the older manual "Create PR"
// feature and are untouched.

interface FlowState {
  status: 'pending' | 'done' | 'error'
  message?: string
  startedAt: number
}

const flows = new Map<string, FlowState>()
let activeFlow: { cancel(): void } | null = null

function flowStates(): Record<string, FlowState> {
  const out: Record<string, FlowState> = {}
  for (const [k, v] of flows) out[k] = v
  return out
}

async function refreshLocalLinearConfig(preferOrg?: string): Promise<IntegrationsStatus | null> {
  if (!isBrokerConnected()) return null
  const status = await fetchIntegrationsStatus()
  const current = getLinearAppConfig()
  const wanted = preferOrg ?? current?.orgId
  const install =
    status.linear.installs.find((i) => i.orgId === wanted && !i.revoked) ??
    status.linear.installs.find((i) => !i.revoked)
  if (!install) {
    if (current) deleteLinearAppConfig()
    return status
  }
  setLinearAppConfig({
    orgId: install.orgId,
    orgName: install.workspaceName,
    urlKey: install.urlKey,
    appUserId: install.appUserId,
    appUserName: install.appUserName,
    linearUserId: install.linearUserId,
    linearUserName: install.linearUserName,
  })
  return status
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function brokerErrorResponse(err: unknown): { body: { error: string; code?: string }; status: 400 | 401 | 403 | 409 | 500 | 502 } {
  if (err instanceof BrokerError) {
    const status =
      err.status === 401 ? 401 : err.status === 403 ? 403 : err.status === 409 ? 409 : err.status >= 500 ? 502 : 400
    return { body: { error: err.message, code: err.code }, status }
  }
  return { body: { error: errorMessage(err, 'Request failed') }, status: 500 }
}


interface CreatePrBody {
  repoPath?: string
  branchName?: string
  baseBranch?: string
  commitMessage?: string
  /** Off = push only what is already committed, leaving the working tree alone. */
  commitLocalChanges?: boolean
  remote?: string
}

/** Carries the HTTP status a failed precondition should map to. */
class PrRequestError extends Error {
  constructor(readonly status: 400 | 500, message: string) {
    super(message)
  }
}

/**
 * Get the branch into a state GitHub can open a PR from: make sure we are on a
 * branch that is not the base, optionally commit the working tree, and push.
 * Shared by "create the PR here" and "open the PR in the browser".
 */
async function prepareBranchForPr(
  repoPath: string,
  opts: {
    branchName: string
    baseBranch: string
    commitMessage?: string
    commitLocalChanges?: boolean
    remote?: string
  },
): Promise<{ owner: string; repo: string; remoteName: string }> {
  const remotes = await gitService.listRemotes(repoPath)
  const remote = remotes.find((r) => r.name === (opts.remote ?? 'origin')) ?? remotes[0]
  if (!remote) throw new PrRequestError(400, 'No git remote configured')
  const parsed = parseGithubRemote(remote.url)
  if (!parsed) throw new PrRequestError(400, `Remote ${remote.url} is not a GitHub repo`)

  const currentBranch = await gitService.getCurrentBranch(repoPath)
  if (currentBranch === opts.baseBranch || opts.branchName !== currentBranch) {
    if (await gitService.localBranchExists(repoPath, opts.branchName)) {
      throw new PrRequestError(
        400,
        `Branch ${opts.branchName} already exists locally. Pick a different name.`,
      )
    }
    await gitService.checkoutNewBranch(repoPath, opts.branchName)
  }

  if (opts.commitLocalChanges !== false) {
    const status = await gitService.getStatus(repoPath)
    const hasChanges =
      status.staged.length + status.unstaged.length + status.untracked.length > 0
    if (hasChanges) {
      if (!opts.commitMessage) {
        throw new PrRequestError(400, 'commitMessage is required for uncommitted changes')
      }
      await gitService.stageAll(repoPath)
      await gitService.commit(repoPath, opts.commitMessage)
    }
  }

  await gitService.pushBranch(repoPath, remote.name, opts.branchName, true)
  return { owner: parsed.owner, repo: parsed.repo, remoteName: remote.name }
}

export function integrationsRoutes(
  storage: ProjectStorageAdapter & TaskStorageAdapter & ChannelStorageAdapter & NotificationStorageAdapter & AgentBindingStorageAdapter,
) {
  const router = new Hono()

  // Inbound webhook events forwarded by the broker (gateway/surfaces/route.ts).
  router.route('/events', surfaceEventsRoutes(storage))

  // ---------- combined status for Settings ----------

  router.get('/app/status', async (c) => {
    const saasConnected = isBrokerConnected()
    let broker: IntegrationsStatus | null = null
    let brokerError: string | undefined
    if (saasConnected) {
      try {
        broker = await refreshLocalLinearConfig()
      } catch (err) {
        brokerError = errorMessage(err, 'Could not reach the broker')
      }
    }
    return c.json({
      saasConnected,
      brokerError,
      linear: {
        enabled: broker?.linear.enabled ?? false,
        installs: broker?.linear.installs ?? [],
        local: getLinearAppConfig(),
      },
      github: {
        enabled: broker?.github.enabled ?? false,
        appSlug: broker?.github.appSlug ?? '',
        login: broker?.github.login ?? '',
        installs: broker?.github.installs ?? [],
      },
      delegation: getLinearDelegationConfig(),
      flows: flowStates(),
    })
  })

  // ---------- install / link flows (browser round-trips) ----------

  async function startFlow(kind: IntegrationFlowKind) {
    activeFlow?.cancel()
    const flow = await beginIntegrationFlow(kind)
    activeFlow = flow
    flows.set(kind, { status: 'pending', startedAt: Date.now() })
    flow.done
      .then(async (result) => {
        if (kind.startsWith('linear/')) {
          await refreshLocalLinearConfig(result.org)
        } else {
          forgetInstallationCache()
        }
        flows.set(kind, { status: 'done', startedAt: Date.now() })
        console.log('[integrations] flow completed', { kind, result })
      })
      .catch((err) => {
        flows.set(kind, { status: 'error', message: errorMessage(err, 'Authorization failed'), startedAt: Date.now() })
        console.error('[integrations] flow failed', kind, err)
      })
      .finally(() => {
        if (activeFlow === flow) activeFlow = null
      })
    return { authorizeUrl: flow.authorizeUrl }
  }

  for (const kind of ['linear/install', 'linear/link', 'github/install', 'github/link'] as const) {
    router.post(`/${kind.replace('/', '/app/')}`, async (c) => {
      if (!isBrokerConnected()) {
        return c.json({ error: 'Sign in on the Remote tab first.', code: 'saas_not_connected' }, 400)
      }
      try {
        return c.json(await startFlow(kind))
      } catch (err) {
        const { body, status } = brokerErrorResponse(err)
        return c.json(body, status)
      }
    })
  }

  router.post('/linear/app/unlink', async (c) => {
    const local = getLinearAppConfig()
    const body = await c.req.json<{ orgId?: string }>().catch(() => ({}) as { orgId?: string })
    const orgId = body.orgId ?? local?.orgId
    if (!orgId) return c.json({ error: 'orgId is required' }, 400)
    try {
      await unlinkLinear(orgId)
      await refreshLocalLinearConfig(orgId)
      return c.json({ success: true })
    } catch (err) {
      const { body: b, status } = brokerErrorResponse(err)
      return c.json(b, status)
    }
  })

  router.post('/linear/app/uninstall', async (c) => {
    const local = getLinearAppConfig()
    const body = await c.req.json<{ orgId?: string }>().catch(() => ({}) as { orgId?: string })
    const orgId = body.orgId ?? local?.orgId
    if (!orgId) return c.json({ error: 'orgId is required' }, 400)
    try {
      await uninstallLinear(orgId)
      deleteLinearAppConfig()
      return c.json({ success: true })
    } catch (err) {
      const { body: b, status } = brokerErrorResponse(err)
      return c.json(b, status)
    }
  })

  router.delete('/github/app/installations/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id)) return c.json({ error: 'bad installation id' }, 400)
    try {
      await forgetGithubInstallation(id)
      forgetInstallationCache()
      return c.json({ success: true })
    } catch (err) {
      const { body, status } = brokerErrorResponse(err)
      return c.json(body, status)
    }
  })

  // Which projects the App covers, by their origin remote.
  router.get('/github/app/coverage', async (c) => {
    const out: Array<{ projectId: number; name: string; repo: string | null; covered: boolean; installationId: number | null }> = []
    for (const p of storage.listProjects()) {
      const repo = await repoOfProject(p.rootPath)
      let installationId: number | null = null
      if (repo && isBrokerConnected()) {
        const ref = parseRepoFull(repo)
        if (ref) installationId = await installationFor(ref).catch(() => null)
      }
      out.push({ projectId: p.id, name: p.name, repo, covered: installationId != null, installationId })
    }
    return c.json({ projects: out })
  })

  // ---------- how delegations start here ----------

  router.put('/linear/delegation', async (c) => {
    const body = await c.req.json<{ defaultAgentId?: number | null }>()
    const defaultAgentId = typeof body.defaultAgentId === 'number' ? body.defaultAgentId : null
    if (defaultAgentId != null && !storage.getAgent(defaultAgentId)) {
      return c.json({ error: 'agent not found' }, 400)
    }
    setLinearDelegationConfig({ defaultAgentId })
    return c.json({ delegation: getLinearDelegationConfig() })
  })

  // ---------- Linear data, as the workspace agent ----------

  function requireOrg(): { orgId: string; linearUserName?: string } | null {
    const local = getLinearAppConfig()
    if (!local) return null
    return { orgId: local.orgId, linearUserName: local.linearUserName }
  }

  router.get('/linear/teams', async (c) => {
    const org = requireOrg()
    if (!org) return c.json({ error: 'Linear is not connected' }, 400)
    try {
      const teams = await fetchLinearTeams(org.orgId)
      return c.json({ teams: teams.map((t) => ({ ...t, projects: [], labels: [] })) })
    } catch (err) {
      const { body, status } = brokerErrorResponse(err)
      return c.json(body, status)
    }
  })

  // What the Publish to Linear control needs: the teams, and the one this
  // project published to last time.
  router.get('/linear/publish-options', async (c) => {
    const org = requireOrg()
    if (!org) return c.json({ error: 'Linear is not connected' }, 400)
    const projectId = Number(c.req.query('projectId'))
    try {
      const teams = await fetchLinearTeams(org.orgId)
      return c.json({
        teams: teams.map((t) => ({ id: t.id, name: t.name, key: t.key })),
        defaultTeamId: Number.isFinite(projectId) ? getLinearPublishTeam(projectId) : null,
      })
    } catch (err) {
      const { body, status } = brokerErrorResponse(err)
      return c.json(body, status)
    }
  })

  router.get('/linear/teams/:teamId', async (c) => {
    const org = requireOrg()
    if (!org) return c.json({ error: 'Linear is not connected' }, 400)
    try {
      return c.json(await fetchLinearTeamDetails(org.orgId, c.req.param('teamId')))
    } catch (err) {
      const { body, status } = brokerErrorResponse(err)
      return c.json(body, status)
    }
  })

  router.post('/linear/issues', async (c) => {
    const org = requireOrg()
    if (!org) return c.json({ error: 'Linear is not connected' }, 400)
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
      const issue = await createLinearIssue(org.orgId, {
        teamId: body.teamId,
        title: body.title,
        description: body.description,
        projectId: body.projectId,
        priority: body.priority,
        labelIds: body.labelIds,
        createAsUser: org.linearUserName,
      })
      // Later delegations on this issue come back to this machine.
      void claimRoute('linear_issue', issue.id)
      return c.json({ issue })
    } catch (err) {
      const { body: b, status } = brokerErrorResponse(err)
      return c.json(b, status)
    }
  })

  // Publish a task as a Linear issue (design.md §11.1). The issue is assigned
  // to the workspace agent; if Linear opens an agent session for that, the
  // inbound handler finds this task by the issue surface and attaches to the
  // already-running (or about-to-run) session instead of starting a second one.
  router.post('/linear/publish-task', async (c) => {
    if (!getLinearAppConfig()) return c.json({ error: 'Linear is not connected' }, 400)
    const body = await c.req.json<{ taskId?: number; teamId?: string; projectId?: string }>()
    const task = typeof body.taskId === 'number' ? storage.taskGet(body.taskId) : null
    if (!task) return c.json({ error: 'taskId is required' }, 400)
    try {
      const issue = await publishTaskToLinear(task, { teamId: body.teamId, projectId: body.projectId })
      return c.json({ issue, alreadyPublished: issue.alreadyPublished === true })
    } catch (err) {
      const { body: b, status } = brokerErrorResponse(err)
      return c.json(b, status)
    }
  })

  /**
   * Whether PRs can be opened from the app at all. There is no app-held GitHub
   * credential any more — this reports on the user's own `gh` login, which is
   * the same one their terminal uses.
   */
  router.get('/github/cli-status', async (c) => {
    return c.json(await getGhStatus())
  })

  // Entirely local: owner/repo come from the remote URL and the default branch
  // from origin/HEAD, so this stays usable (and cheap) whether or not `gh` is
  // signed in — the "open the PR in the browser" path needs no credentials.
  router.post('/github/repo-status', async (c) => {
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

      // `origin/main` -> `main`; the remote prefix is not a branch name.
      const localDefault = await gitService.getDefaultBaseBranch(repoPath)
      const defaultBranch = localDefault ? localDefault.replace(/^[^/]+\//, '') : null

      // A branch that was never pushed reports ahead = 0 (there is nothing to
      // count against), so "is there anything to push?" needs the upstream too.
      const hasUpstream = (await gitService.getPushStatus(repoPath)).upstream != null

      // PRs are opened with the user's own `gh` login; there is no app-level
      // credential to fall back on.
      const gh = await getGhStatus()

      return c.json({
        isRepo: true,
        ghInstalled: gh.isInstalled,
        ghAuthenticated: gh.isAuthenticated,
        canCreatePr: gh.isAuthenticated,
        remoteName: origin?.name ?? null,
        owner: parsed?.owner ?? null,
        repo: parsed?.repo ?? null,
        currentBranch,
        defaultBranch,
        ahead: status.ahead,
        behind: status.behind,
        hasUpstream,
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
    const body = await c.req.json<CreatePrBody & { title?: string; body?: string; draft?: boolean }>()
    const { title, baseBranch, branchName } = body
    if (!body.repoPath || !title || !baseBranch || !branchName) {
      return c.json({ error: 'repoPath, title, branchName, baseBranch are required' }, 400)
    }

    // PRs are authored with the user's own GitHub login, the same one their
    // terminal uses — the app never holds a GitHub credential of its own.
    const gh = await getGhStatus()
    if (!gh.isAuthenticated) {
      return c.json({ error: 'GitHub CLI is not authenticated — run `gh auth login`' }, 400)
    }

    try {
      await prepareBranchForPr(body.repoPath, {
        ...body,
        branchName,
        baseBranch,
        commitMessage: body.commitMessage ?? title,
      })

      // The branch is pushed by now, which is what `gh pr create` needs — it
      // would otherwise prompt, and there is no terminal to answer it.
      const pr = await ghPrCreate(body.repoPath, {
        headBranch: branchName,
        baseBranch,
        title,
        body: body.body ?? '',
        draft: body.draft ?? false,
      })

      return c.json({ pr })
    } catch (err) {
      return c.json({ error: errorMessage(err, 'Failed to create PR') }, err instanceof PrRequestError ? err.status : 500)
    }
  })

  /**
   * Same commit/push preparation as create-pr, but stops short of the GitHub
   * API and hands back the compare URL — the "open the PR in the browser"
   * path, which is also the only one that works without a token.
   */
  router.post('/github/push-for-pr', async (c) => {
    const body = await c.req.json<CreatePrBody>()
    const { baseBranch, branchName } = body
    if (!body.repoPath || !baseBranch || !branchName) {
      return c.json({ error: 'repoPath, branchName, baseBranch are required' }, 400)
    }

    try {
      const { owner, repo } = await prepareBranchForPr(body.repoPath, { ...body, branchName, baseBranch })
      const compareUrl = `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branchName)}?expand=1`
      return c.json({ compareUrl })
    } catch (err) {
      return c.json({ error: errorMessage(err, 'Failed to push branch') }, err instanceof PrRequestError ? err.status : 500)
    }
  })

  /**
   * The open PR for a branch, so the toolbar can offer "View PR" instead of a
   * "Create PR" that GitHub would reject as a duplicate. Needs `gh`; without it
   * the answer is simply "unknown", not an error.
   */
  router.post('/github/pr-for-branch', async (c) => {
    const { repoPath, branch } = await c.req.json<{ repoPath?: string; branch?: string }>()
    if (!repoPath || !branch) return c.json({ pr: null })
    const gh = await getGhStatus()
    if (!gh.isAuthenticated) return c.json({ pr: null })
    return c.json({ pr: await ghPrForBranch(repoPath, branch) })
  })

  return router
}
