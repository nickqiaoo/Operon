import type { PeerBudget, PeerMemberOptions, TeammateSessionOptions, TeammateSpawnRequest } from 'operon-agents-peers'

/**
 * The seam between the Teams extension bundle and the operon host.
 *
 * The bundle is a FILE extension (built by `scripts/build-peers-extension.mjs`, installed
 * into the extensions dir at startup), so it cannot import host code. Everything it needs
 * from the app — the teammate types the user configured, how a teammate session is born,
 * and the hook that turns a fresh teammate into a chat row — comes through one host
 * service registered with `createHarness({ services })` and declared in the bundle's
 * `uses`. Replaceable services expose methods only, hence every member is a function.
 */
export const TEAMS_SERVICE = 'operon-teams' as const

export interface TeamsExtensionConfig {
  budget: PeerBudget
  /** Teammate types the model may `Team spawn`, with what the roster shows for each. */
  types: Record<string, { title: string; description?: string }>
}

export interface TeamsHostService {
  /** Read every time the `workspace` half runs (each open workspace, on load and on reload) —
   *  a config change is applied by reloading the extension. */
  config(): Promise<TeamsExtensionConfig>
  /** The session options a teammate of `request.type` is born with (workDir, MCP, permissions, prompt). */
  teammateOptions(request: TeammateSpawnRequest): Promise<TeammateSessionOptions>
  /** Right after the teammate session exists and BEFORE its first peer message is routed. */
  onTeammateCreated(sessionId: string, member: PeerMemberOptions): Promise<void>
}

export type TeamsExtensionServices = { readonly [TEAMS_SERVICE]: TeamsHostService }
