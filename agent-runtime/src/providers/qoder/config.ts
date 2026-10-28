import type { McpServerConfig } from '@qoder-ai/qoder-agent-sdk'
import type { RuntimeContext } from '../../context.js'
import type { ProviderDescriptor, SessionOptions } from '../../types.js'
import { OPERON_INFRA_ALLOWED_TOOLS } from '../claude/config.js'
import type { QoderEffort, QoderMode, QoderRuntimeSettings } from './types.js'

/** `RuntimeHost.resolveBinary` id; the executable itself is `qodercli`. */
export const QODER_CLI_ID = 'qoder'

export const DEFAULT_MODE_ID: QoderMode = 'default'
export const DEFAULT_EFFORT: QoderEffort = 'medium'

export const QODER_MODES: ProviderDescriptor['modes'] = [
  { id: 'default', name: 'Default', description: 'Standard permission prompts' },
  { id: 'auto', name: 'Auto', description: 'Qoder auto-approves safe actions, asks when risky' },
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edits' },
  { id: 'plan', name: 'Plan', description: 'Plan without writing code' },
  { id: 'bypassPermissions', name: 'Bypass', description: 'Skip all permission prompts' },
  { id: 'dontAsk', name: "Don't Ask", description: 'Only use pre-approved tools' },
]

export const QODER_THINKING_LEVELS: ProviderDescriptor['thinkingLevels'] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'xHigh' },
  { id: 'max', name: 'Max' },
]

export const QODER_SLASH_COMMANDS: ProviderDescriptor['slashCommands'] = [
  { name: 'compact', description: 'Compact conversation history', type: 'command' },
]

/** Qoder's options block on `createSession`. */
export interface QoderSessionOptions {
  qoder?: {
    /**
     * Server name → tool names to keep in the request as tools of their own.
     * MCP loads lazily here (session.ts): a tool the model has to find through
     * mcp_list / mcp_get first is one a weak model may never call, which for a
     * host's report-back tool means the work is lost.
     */
    alwaysLoadTools?: Record<string, readonly string[]>
  }
}

const QODER_MODE_IDS = new Set<string>(QODER_MODES.map((mode) => mode.id))

export function resolveQoderMode(modeId?: string): QoderMode {
  return modeId && QODER_MODE_IDS.has(modeId) ? (modeId as QoderMode) : DEFAULT_MODE_ID
}

export function resolveQoderEffort(level?: string): QoderEffort {
  switch (level) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return level
    default:
      return DEFAULT_EFFORT
  }
}

function withAlwaysLoad(
  servers: SessionOptions['mcpServers'],
  alwaysLoad: Record<string, readonly string[]> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!servers || !alwaysLoad) return servers as Record<string, McpServerConfig> | undefined
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const tools = alwaysLoad[name]
      return [name, tools?.length ? { ...server, tools: tools.map((tool) => ({ name: tool, alwaysLoad: true })) } : server]
    }),
  ) as Record<string, McpServerConfig>
}

export function buildQoderRuntimeSettings(params: SessionOptions & QoderSessionOptions, ctx: RuntimeContext): QoderRuntimeSettings {
  const cliPath = ctx.resolveBinary(QODER_CLI_ID)
  if (!cliPath) {
    throw new Error('Qoder CLI not configured. Install it from qoder.com or set the path in Settings.')
  }

  // The host's session instructions. Resume does not restore an earlier append
  // (the CLI rebuilds its system prompt per invocation), so it is re-passed on
  // every session creation — same contract as Claude Code.
  const append = params.instructions?.trim()

  return {
    modelId: params.model?.trim() ?? '',
    cwd: params.cwd,
    mode: resolveQoderMode(params.mode),
    effort: resolveQoderEffort(params.effort),
    resume: params.resume,
    forkFrom: params.fork,
    ...(params.writableDirs?.length ? { additionalDirectories: [...params.writableDirs] } : {}),
    pathToQoderCLIExecutable: cliPath,
    allowedTools: [...OPERON_INFRA_ALLOWED_TOOLS],
    mcpServers: withAlwaysLoad(params.mcpServers, params.qoder?.alwaysLoadTools),
    env: ctx.env(params.env),
    systemPrompt: append ? { type: 'preset', preset: 'qodercli', append } : undefined,
  }
}
