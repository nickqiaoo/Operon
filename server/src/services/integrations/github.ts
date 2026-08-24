const GITHUB_API = 'https://api.github.com'

export interface GithubViewer {
  login: string
  name: string | null
  avatarUrl: string
}

export interface GithubRepoInfo {
  defaultBranch: string
  fullName: string
  private: boolean
}

export interface CreateGithubPRInput {
  owner: string
  repo: string
  title: string
  body: string
  head: string
  base: string
  draft?: boolean
}

export interface CreatedGithubPR {
  number: number
  url: string
  title: string
}

async function githubRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `${res.status} ${res.statusText}`
    try {
      const parsed = JSON.parse(text) as { message?: string }
      if (parsed.message) message = parsed.message
    } catch {
      if (text) message += ` ${text}`
    }
    throw new Error(`GitHub API error: ${message}`)
  }

  if (res.status === 204) {
    return undefined as T
  }
  return (await res.json()) as T
}

export async function fetchGithubViewer(token: string): Promise<GithubViewer> {
  const data = await githubRequest<{ login: string; name: string | null; avatar_url: string }>(
    token,
    'GET',
    '/user',
  )
  return { login: data.login, name: data.name, avatarUrl: data.avatar_url }
}

export async function fetchGithubRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<GithubRepoInfo> {
  const data = await githubRequest<{
    default_branch: string
    full_name: string
    private: boolean
  }>(token, 'GET', `/repos/${owner}/${repo}`)
  return {
    defaultBranch: data.default_branch,
    fullName: data.full_name,
    private: data.private,
  }
}

export async function createGithubPR(
  token: string,
  input: CreateGithubPRInput,
): Promise<CreatedGithubPR> {
  const data = await githubRequest<{ number: number; html_url: string; title: string }>(
    token,
    'POST',
    `/repos/${input.owner}/${input.repo}/pulls`,
    {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    },
  )
  return { number: data.number, url: data.html_url, title: data.title }
}

export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  if (!url) return null
  let cleaned = url.trim()
  if (cleaned.endsWith('.git')) cleaned = cleaned.slice(0, -4)

  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/(.+)$/)
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] }

  const httpsMatch = cleaned.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)\/?$/)
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] }

  return null
}
