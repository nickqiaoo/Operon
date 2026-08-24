import type * as acp from '@zed-industries/agent-client-protocol'
import type { Model } from '../../types.js'
import type { AcpDiscoveryContext, AcpModelDiscovery, AcpProviderConfig } from '../acp/index.js'

/**
 * Split cursor-agent's `available_commands_update` entries into skills vs plain
 * commands. Cursor puts nothing on the entry's `_meta`, so the only signal is a
 * trailing "(… skill)" marker in the description — "(builtin skill)",
 * "(project skill)", "(user skill)". Builtin commands and user prompts
 * ("(global)" / "(user)" / no marker) stay plain commands.
 */
function classifyCursorCommand(command: acp.AvailableCommand): 'skill' | 'command' {
  return /\bskill\)\s*$/i.test(command.description ?? '') ? 'skill' : 'command'
}

/** cursor-agent binary; override with CURSOR_AGENT_PATH if not on PATH. */
export const CURSOR_BIN = process.env.CURSOR_AGENT_PATH || 'cursor-agent'

/** ACP "Auto" model id — cursor-agent's session default. */
export const CURSOR_DEFAULT_MODEL_ID = 'default[]'

const CURSOR_FALLBACK_MODELS: Model[] = [
  {
    id: CURSOR_DEFAULT_MODEL_ID,
    name: 'Auto',
    description: 'Cursor automatic model routing',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    providerLogo: 'cursor',
  },
]

/**
 * Read Cursor's models from the ACP `session/new` response. Cursor's model ids
 * are parametrized (e.g. `grok-4.5[effort=high,fast=true]`) and only valid in
 * that exact form for `setSessionModel`, so we must use the ACP list — the flat
 * `cursor-agent --list-models` ids (`grok-4.5`) do not round-trip.
 */
function extractCursorModels(ctx: AcpDiscoveryContext, preferredModelId?: string): AcpModelDiscovery {
  const available = ctx.session?.models?.availableModels ?? []
  const models: Model[] = available.map((entry) => ({
    id: entry.modelId,
    name: entry.name || entry.modelId,
    providerId: 'cursor',
    providerLabel: 'Cursor',
    providerLogo: 'cursor',
  }))

  const resolved = models.length > 0 ? models : CURSOR_FALLBACK_MODELS
  const availableIds = new Set(resolved.map((m) => m.id))
  const advertisedCurrent = ctx.session?.models?.currentModelId

  const currentModelId =
    preferredModelId && availableIds.has(preferredModelId)
      ? preferredModelId
      : advertisedCurrent && availableIds.has(advertisedCurrent)
        ? advertisedCurrent
        : resolved[0].id

  return { models: resolved, currentModelId }
}

export const CURSOR_CONFIG: AcpProviderConfig = {
  providerId: 'cursor',
  cliId: 'cursor',
  label: 'Cursor',
  logo: 'cursor',
  agentArgs: ['acp'],
  fallbackCommand: CURSOR_BIN,
  // Cursor advertises these as ACP session modes; Agent runs tools (gated by
  // request_permission), Plan is read-only planning, Ask is Q&A only.
  modes: [
    { id: 'agent', name: 'Agent', description: 'Full agent with tool access' },
    { id: 'plan', name: 'Plan', description: 'Read-only planning before implementation' },
    { id: 'ask', name: 'Ask', description: 'Q&A only — no edits or command execution' },
  ],
  defaultModeId: 'agent',
  defaultModelId: CURSOR_DEFAULT_MODEL_ID,
  features: {
    permissions: true,
    attachments: true,
    injection: false,
    sessionResume: true,
  },
  modelProbe: 'session',
  probeCommands: true,
  extractModels: extractCursorModels,
  classifyCommand: classifyCursorCommand,
}
