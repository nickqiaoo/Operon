import { lookupGithubRepo, mintGithubInstallationToken } from './broker-client.js'

// GitHub, as the operon App. The private key stays on the broker; this file
// asks it for a one-hour, repo-scoped installation token and calls GitHub
// directly with it (docs/linear-github/design.md §4.2). Tokens live in memory
// only and ride into git through GIT_CONFIG_* for a single command.

const GITHUB_API = 'https://api.github.com'

export interface RepoRef {
  owner: string
  name: string
}

export function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
}

export function parseRepoFull(full: string): RepoRef | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full.trim())
  return m ? { owner: m[1]!, name: m[2]! } : null
}

export interface PullRequestRef {
  number: number
  url: string
  head: string
  base: string
  body: string | null
  state: 'open' | 'closed'
  merged: boolean
}

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()
const installationCache = new Map<string, { installationId: number | null; expiresAt: number }>()
const TOKEN_SLACK_MS = 5 * 60 * 1000
const INSTALLATION_TTL_MS = 10 * 60 * 1000

export class GithubAppError extends Error {
  constructor(
    readonly code: 'not_installed' | 'no_access' | 'api',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GithubAppError'
  }
}

/** The installation covering a repo, or null when the App is not on it. */
export async function installationFor(repo: RepoRef): Promise<number | null> {
  const key = formatRepo(repo).toLowerCase()
  const hit = installationCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.installationId
  const res = await lookupGithubRepo(repo.owner, repo.name)
  const installationId = res.covered && res.installationId ? res.installationId : null
  installationCache.set(key, { installationId, expiresAt: Date.now() + INSTALLATION_TTL_MS })
  return installationId
}

export function forgetInstallationCache(): void {
  installationCache.clear()
  tokenCache.clear()
}

export async function installationToken(repo: RepoRef): Promise<string> {
  const full = formatRepo(repo)
  const cached = tokenCache.get(full.toLowerCase())
  if (cached && cached.expiresAt - TOKEN_SLACK_MS > Date.now()) return cached.token
  const installationId = await installationFor(repo)
  if (!installationId) {
    throw new GithubAppError('not_installed', `The operon GitHub App is not installed on ${full}. Install it from Settings → GitHub.`)
  }
  const minted = await mintGithubInstallationToken(installationId, full).catch((err: unknown) => {
    const e = err as { code?: string; message?: string }
    if (e.code === 'github_no_access') throw new GithubAppError('no_access', e.message ?? 'No access to this repository.')
    throw err
  })
  const expiresAt = Date.parse(minted.expiresAt) || Date.now() + 55 * 60 * 1000
  tokenCache.set(full.toLowerCase(), { token: minted.token, expiresAt })
  return minted.token
}

/**
 * git's environment-config protocol (git ≥ 2.31): the token reaches one push
 * command as an extra header — never on the command line, never in .git/config.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}

export function httpsCloneUrl(repo: RepoRef): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`
}

async function githubRequest<T>(
  repo: RepoRef,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const token = await installationToken(repo)
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok && res.status !== 404) {
    const msg = (data as { message?: string } | null)?.message ?? text.slice(0, 200)
    throw new GithubAppError('api', `GitHub ${method} ${path}: ${res.status} ${msg}`, res.status)
  }
  return { status: res.status, data: data as T }
}

interface RawPull {
  number: number
  html_url: string
  body: string | null
  state: 'open' | 'closed'
  merged: boolean
  merged_at: string | null
  head: { ref: string }
  base: { ref: string }
}

function toPull(p: RawPull): PullRequestRef {
  return {
    number: p.number,
    url: p.html_url,
    head: p.head.ref,
    base: p.base.ref,
    body: p.body,
    state: p.state,
    merged: p.merged || !!p.merged_at,
  }
}

export async function getDefaultBranch(repo: RepoRef): Promise<string> {
  const { data } = await githubRequest<{ default_branch: string }>(repo, 'GET', `/repos/${repo.owner}/${repo.name}`)
  return data.default_branch
}

export async function getPullRequest(repo: RepoRef, number: number): Promise<PullRequestRef | null> {
  const { status, data } = await githubRequest<RawPull>(repo, 'GET', `/repos/${repo.owner}/${repo.name}/pulls/${number}`)
  return status === 404 ? null : toPull(data)
}

export async function findOpenPullRequest(repo: RepoRef, branch: string): Promise<PullRequestRef | null> {
  const { data } = await githubRequest<RawPull[]>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=1`,
  )
  return Array.isArray(data) && data[0] ? toPull(data[0]) : null
}

export async function createPullRequest(
  repo: RepoRef,
  input: { title: string; body: string; head: string; base: string; draft?: boolean },
): Promise<PullRequestRef> {
  const { data } = await githubRequest<RawPull>(repo, 'POST', `/repos/${repo.owner}/${repo.name}/pulls`, input)
  return toPull(data)
}

export async function createIssueComment(repo: RepoRef, number: number, body: string): Promise<{ id: number; url: string }> {
  const { data } = await githubRequest<{ id: number; html_url: string }>(
    repo,
    'POST',
    `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
    { body },
  )
  return { id: data.id, url: data.html_url }
}

export async function replyToReviewComment(
  repo: RepoRef,
  pullNumber: number,
  commentId: number,
  body: string,
): Promise<{ id: number; url: string }> {
  const { data } = await githubRequest<{ id: number; html_url: string }>(
    repo,
    'POST',
    `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/comments/${commentId}/replies`,
    { body },
  )
  return { id: data.id, url: data.html_url }
}

const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

/** Whether a login may steer the agent from a PR: write access to the repo. */
export async function hasWriteAccess(repo: RepoRef, login: string): Promise<boolean> {
  const { status, data } = await githubRequest<{ permission?: string }>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
  )
  if (status === 404) return false
  return WRITE_PERMISSIONS.has(data.permission ?? '')
}
