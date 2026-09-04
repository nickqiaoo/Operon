import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { getShellEnv } from './adapter/bundled-cli-paths.js'
import { getEnvVars } from './env-config.js'

/**
 * Whether the Antigravity ACP server is ready to be spawned.
 *
 * This exists to stop a browser window appearing out of nowhere. The agent
 * authenticates itself: given no credentials it drives an interactive Google
 * OAuth flow from inside `session/new`, which in operon means a user sends a
 * chat message and a login page erupts with no explanation of where it came
 * from. Checking first lets the UI say "this will open your browser" *before*
 * it happens, or "you need to sign in" instead of a failed turn.
 *
 * None of this is operon's own state — it is the agent's, shared with the
 * gemini CLI family through `$GEMINI_HOME`. We only read it, and only write the
 * one file when the user explicitly asks us to.
 */

/** The agent resolves its home this way; `$GEMINI_HOME` wins when set. */
function geminiHome(): string {
  const fromEnv = runtimeEnv().GEMINI_HOME?.trim()
  return fromEnv || path.join(homedir(), '.gemini')
}

/** The env the agent will actually be spawned with, not this process's. */
function runtimeEnv(): Record<string, string> {
  return { ...getShellEnv(), ...process.env, ...getEnvVars() } as Record<string, string>
}

function settingsPath(): string {
  return path.join(geminiHome(), 'antigravity-acp', 'settings.json')
}

/** The four methods the agent accepts, straight from its own error message. */
export type AntigravityAuthType = 'oauth-personal' | 'gemini-api-key' | 'oauth-business' | 'agent-platform'

export type AntigravityAuthState =
  /** Credentials are in place; spawning will not prompt for anything. */
  | 'ready'
  /** A method is chosen but has no credentials yet — first use opens a browser. */
  | 'needs-login'
  /** A method is chosen but its prerequisite (an API key, a GCP project) is missing. */
  | 'incomplete'
  /** No method chosen: the agent would refuse to open a session at all. */
  | 'not-configured'

export interface AntigravityAuthStatus {
  state: AntigravityAuthState
  authType?: AntigravityAuthType
  /** Absolute path of the settings file, so the UI can name it. */
  settingsPath: string
  /** What is missing, phrased for a person. Absent when ready. */
  detail?: string
}

interface AcpSettings {
  auth?: { type?: string }
  gcp?: { project?: string; location?: string }
}

async function readSettings(): Promise<AcpSettings | null> {
  try {
    return JSON.parse(await readFile(settingsPath(), 'utf8')) as AcpSettings
  } catch {
    return null
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target)
    return true
  } catch {
    return false
  }
}

export async function getAntigravityAuthStatus(): Promise<AntigravityAuthStatus> {
  const settings = await readSettings()
  const authType = settings?.auth?.type as AntigravityAuthType | undefined
  const base = { settingsPath: settingsPath() }

  if (!authType) {
    return {
      ...base,
      state: 'not-configured',
      detail: 'No sign-in method chosen yet. Antigravity will refuse to start a session.',
    }
  }

  const env = runtimeEnv()
  switch (authType) {
    case 'oauth-personal': {
      // Shared with the gemini CLI — signing in there is enough, and signing in
      // here writes the same file.
      const signedIn = await fileExists(path.join(geminiHome(), 'oauth_creds.json'))
      return signedIn
        ? { ...base, state: 'ready', authType }
        : {
            ...base,
            state: 'needs-login',
            authType,
            detail: 'Your first message will open a Google sign-in page in your browser.',
          }
    }
    case 'gemini-api-key':
      return env.GEMINI_API_KEY?.trim()
        ? { ...base, state: 'ready', authType }
        : { ...base, state: 'incomplete', authType, detail: 'Set GEMINI_API_KEY in Settings → Env.' }
    case 'oauth-business':
      return settings?.gcp?.project && settings?.gcp?.location
        ? { ...base, state: 'ready', authType }
        : {
            ...base,
            state: 'incomplete',
            authType,
            detail: 'Gemini Enterprise needs gcp.project and gcp.location in settings.json.',
          }
    case 'agent-platform': {
      const hasKey = !!env.GOOGLE_API_KEY?.trim()
      const project = settings?.gcp?.project || env.GOOGLE_CLOUD_PROJECT?.trim()
      const location = settings?.gcp?.location || env.GOOGLE_CLOUD_LOCATION?.trim()
      return hasKey || (project && location)
        ? { ...base, state: 'ready', authType }
        : {
            ...base,
            state: 'incomplete',
            authType,
            detail: 'Needs GOOGLE_API_KEY, or a project and location plus Application Default Credentials.',
          }
    }
    default:
      return { ...base, state: 'not-configured', detail: `Unrecognised auth type "${String(authType)}".` }
  }
}

/**
 * Record the sign-in method the user picked.
 *
 * Only ever called from an explicit action in Settings. This writes into the
 * gemini family's shared config directory rather than operon's own, so it is
 * not something to do quietly on the user's behalf — the UI names the file it
 * is about to touch. Existing keys are preserved.
 */
export async function setAntigravityAuthType(type: AntigravityAuthType): Promise<AntigravityAuthStatus> {
  const target = settingsPath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = (await readSettings()) ?? {}
  const next: AcpSettings = { ...existing, auth: { ...existing.auth, type } }
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`)
  return getAntigravityAuthStatus()
}
