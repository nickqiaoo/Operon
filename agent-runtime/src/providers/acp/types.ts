import type * as acp from '@zed-industries/agent-client-protocol'
import type { Model, Mode, ProviderFeatures, RuntimeTextStreamPart } from '../../types.js'

/** The AI-SDK `finish-step` usage shape the mapper reports for a turn. */
export type AcpUsage = Extract<RuntimeTextStreamPart, { type: 'finish-step' }>['usage']

/** Result of resolving the model list for a provider descriptor. */
export interface AcpModelDiscovery {
  models: Model[]
  currentModelId: string
}

/**
 * What a one-shot handshake yielded for model discovery. `initialize` is present
 * when `modelProbe` is 'initialize' or 'session'; `session` only when 'session'.
 * Both are null when `modelProbe` is 'none' or the probe failed.
 */
export interface AcpDiscoveryContext {
  initialize: acp.InitializeResponse | null
  session: acp.NewSessionResponse | null
  /**
   * Commands the agent pushed during the probe, when `probeCommands` is set.
   * Null when not requested, unsupported, or the push never arrived.
   */
  commands: acp.AvailableCommand[] | null
}

/** How far the descriptor probe goes to discover a provider's model list. */
export type AcpModelProbe = 'none' | 'initialize' | 'session'

/**
 * Per-provider configuration for an ACP-backed runtime. The shared ACP session
 * handles the protocol (spawn → initialize → newSession → prompt/cancel and the
 * `session/update` + `session/request_permission` callbacks); each provider only
 * supplies its CLI invocation, UI modes, and how to read its model list.
 */
export interface AcpProviderConfig {
  readonly providerId: string
  /** Key passed to `RuntimeHost.resolveCliPath` (e.g. 'grok', 'kimi', 'cursor'). */
  readonly cliId: string
  readonly label: string
  readonly logo: string
  /** Args after the binary that start the ACP stdio server (e.g. ['agent','stdio'] or ['acp']). */
  readonly agentArgs: string[]
  /**
   * Command to spawn when `resolveCliPath(cliId)` returns undefined (provider not
   * wired into the host's CLI-path registry). Resolved from PATH by the OS.
   */
  readonly fallbackCommand?: string
  /** UI modes surfaced in the descriptor; each `id` must be a valid ACP `modeId`. */
  readonly modes: Mode[]
  readonly defaultModeId: string
  readonly defaultModelId: string
  readonly features: ProviderFeatures
  /**
   * How far `getDescriptor` spawns to discover models: 'none' resolves statically
   * without spawning; 'initialize' runs a one-shot `initialize`; 'session' also
   * runs `newSession` (for agents that only advertise models per session).
   */
  readonly modelProbe: AcpModelProbe
  /**
   * Discover the agent's slash commands during the descriptor probe, so the `/`
   * menu is populated before the user's first message rather than after it.
   *
   * Commands are *pushed* after `session/new`, so this deepens the probe to a
   * session even when `modelProbe` is 'initialize' — for Grok that costs ~1.3s
   * on top of initialize, and the push itself lands ~10ms after newSession
   * returns. Leave unset for agents whose commands aren't worth that.
   */
  readonly probeCommands?: boolean
  /** Resolve the model list from a completed handshake (see AcpDiscoveryContext). */
  extractModels(ctx: AcpDiscoveryContext, preferredModelId?: string): AcpModelDiscovery
  /**
   * Parse a turn's token usage from the `_meta` on the `prompt` response. ACP has
   * no standard usage field, so agents that report it do so through `_meta` in an
   * agent-specific shape — only those providers implement this hook; the rest
   * report zero usage. Return undefined when `meta` carries no usage.
   */
  parseUsage?(meta: Record<string, unknown> | undefined): AcpUsage | undefined
  /**
   * Read the *current context size* off a `session/update` notification's `_meta`.
   *
   * This is deliberately not derived from `parseUsage`: a turn's `inputTokens` is
   * summed across every model call it made, and each call re-sends the whole
   * context (mostly as cache reads). A 5-call turn over a 15K context reports
   * ~74K input — so using it as context occupancy over-reports by roughly the
   * model-call count and blows past 100% on long turns. Agents that expose a
   * live context gauge report it here instead; the rest surface no percentage.
   */
  parseContextTokens?(meta: Record<string, unknown> | undefined): number | undefined
  /**
   * Classify one entry of `available_commands_update` as a skill or a plain
   * command. `name`/`description` are standard ACP, but nothing in the protocol
   * says what a command *is* — agents that ship skills mark them on the entry's
   * `_meta` extension point in their own shape. Return undefined to leave an
   * entry as a plain command; omit the hook to classify every entry that way.
   */
  classifyCommand?(command: acp.AvailableCommand): 'skill' | 'command' | undefined
}
