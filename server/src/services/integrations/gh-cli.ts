import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const GH_TIMEOUT_MS = 60_000
const STATUS_CACHE_MS = 30_000

/**
 * gh inherits the enriched PATH that electron/main.ts builds from the login
 * shell, so a Homebrew install is reachable. These two vars only quiet it down:
 * no update banner, no interactive prompting when something is missing.
 */
const GH_ENV = {
  ...process.env,
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
}

export interface GhStatus {
  isInstalled: boolean
  isAuthenticated: boolean
}

let statusCache: { value: GhStatus; at: number } | null = null

/**
 * Whether `gh` is usable for GitHub calls. `gh auth token` is the cheap probe:
 * unlike `gh auth status` it reads the local keyring instead of calling the
 * API, so this stays fast enough to sit behind a status endpoint. Its stdout is
 * a token — never logged, never returned.
 */
export async function getGhStatus(): Promise<GhStatus> {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value
  }

  let value: GhStatus
  try {
    await run('gh', ['auth', 'token'], { env: GH_ENV, timeout: GH_TIMEOUT_MS })
    value = { isInstalled: true, isAuthenticated: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT means no gh on PATH; any other failure means gh ran and said no.
    value = { isInstalled: code !== 'ENOENT', isAuthenticated: false }
  }

  statusCache = { value, at: Date.now() }
  return value
}

/** Called after an auth change would make the cached answer wrong. */
export function forgetGhStatus(): void {
  statusCache = null
}

/** gh reports failures on stderr; surface that instead of "Command failed". */
function ghError(err: unknown, fallback: string): Error {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  const detail = (e.stderr || e.stdout || e.message || '').trim()
  return new Error(detail || fallback)
}

export interface GhPrCreateOptions {
  headBranch: string
  baseBranch: string
  title: string
  body: string
  draft?: boolean
}

export interface GhPr {
  number: number
  url: string
  title: string
}

/** First URL in gh's output — it prints the PR link on success. */
function parsePrUrl(stdout: string): string | null {
  return /https?:\/\/\S+/.exec(stdout)?.[0] ?? null
}

function parsePrNumber(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url)
  return match ? Number(match[1]) : 0
}

/**
 * Create the PR through the user's own `gh` login, so no token has to be
 * configured in the app. The head branch must already be pushed — gh would
 * otherwise prompt, and there is no terminal here to answer it.
 */
export async function ghPrCreate(cwd: string, options: GhPrCreateOptions): Promise<GhPr> {
  const args = [
    'pr',
    'create',
    '--head',
    options.headBranch,
    '--base',
    options.baseBranch,
    '--title',
    options.title,
    '--body',
    options.body,
  ]
  if (options.draft) args.push('--draft')

  try {
    const { stdout } = await run('gh', args, { cwd, env: GH_ENV, timeout: GH_TIMEOUT_MS })
    const url = parsePrUrl(stdout)
    if (!url) throw new Error(`gh did not return a pull request URL: ${stdout.trim()}`)
    return { number: parsePrNumber(url), url, title: options.title }
  } catch (err) {
    throw ghError(err, 'gh pr create failed')
  }
}

export interface ExistingPr {
  number: number
  url: string
  title: string
  isDraft: boolean
}

/**
 * The open PR for a branch, if there is one. Used to turn "Create PR" into
 * "View PR" instead of letting GitHub reject a duplicate.
 */
export async function ghPrForBranch(cwd: string, branch: string): Promise<ExistingPr | null> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--limit',
        '1',
        '--json',
        'number,url,title,isDraft',
      ],
      { cwd, env: GH_ENV, timeout: GH_TIMEOUT_MS },
    )
    const parsed: unknown = JSON.parse(stdout || '[]')
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const pr = parsed[0] as ExistingPr
    return { number: pr.number, url: pr.url, title: pr.title, isDraft: pr.isDraft }
  } catch {
    // A repo gh cannot see (no access, not a GitHub remote) is not an error
    // here — it just means we have nothing to link to.
    return null
  }
}
