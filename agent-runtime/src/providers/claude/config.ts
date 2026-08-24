import type { McpServerConfig, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { getRuntimeHost } from '../../host.js'
import type { ProviderDescriptor, RuntimeSessionParams } from '../../types.js'
import { buildRuntimeEnv } from '../../runtime-env.js'
import type { ClaudeRuntimeSettings, ClaudeThinkingLevel } from './types.js'
import { MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT } from '../../memory-resolver-prompt.js'

/** CLI alias: clear overrides / use account or org recommended model. */
export const DEFAULT_MODEL_ID = 'default'
export const DEFAULT_MODE_ID = 'default'
export const DEFAULT_THINKING_LEVEL: ClaudeThinkingLevel = 'high'

/**
 * Claude Code model aliases pass through unchanged. Only empty / missing values
 * fall back to DEFAULT_MODEL_ID. Live options come from CLI init — do not keep
 * a static model table that will drift (e.g. missing `fable`).
 */
export function normalizeModelId(modelId?: string): string {
  const trimmed = modelId?.trim()
  return trimmed ? trimmed : DEFAULT_MODEL_ID
}

export const CLAUDE_SERVICE_TIERS: ProviderDescriptor['serviceTiers'] = [
  { id: 'fast', name: 'Fast', description: 'Prioritize faster responses' },
]

export const CLAUDE_MODES: ProviderDescriptor['modes'] = [
  { id: 'default', name: 'Default', description: 'Standard permission prompts' },
  // 'auto' — Claude decides per action whether to run it or ask. Whether a
  // given model supports it is advertised by the CLI as ModelInfo.supportsAutoMode
  // (via query.supportedModels()); we don't query that and expose 'auto' for all
  // models. Passes straight through as a PermissionMode — unlike bypass it must
  // NOT set allowDangerouslySkipPermissions.
  { id: 'auto', name: 'Auto', description: 'Claude auto-approves safe actions, asks when risky' },
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edits' },
  { id: 'plan', name: 'Plan', description: 'Plan without writing code' },
  { id: 'bypassPermissions', name: 'Bypass', description: 'Skip all permission prompts' },
  { id: 'dontAsk', name: "Don't Ask", description: 'Only use pre-approved tools' },
]

export const CLAUDE_THINKING_LEVELS: ProviderDescriptor['thinkingLevels'] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'xHigh' },
  { id: 'max', name: 'Max' },
]

export const CLAUDE_SLASH_COMMANDS: ProviderDescriptor['slashCommands'] = [
  { name: 'compact', description: 'Compact conversation history', type: 'command' },
]

/**
 * Memory prompts plus the host's session instructions (persona / collab rules).
 * Baked into the preset append at settings-build time — the warm query reads
 * systemPrompt once at creation, and resume does NOT restore a previous append
 * (the CLI rebuilds the system prompt from the current invocation), so the
 * host re-passes instructions on every session creation.
 */
function buildSystemPromptAppend(instructions?: string): string | undefined {
  const parts = [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, instructions?.trim()].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function resolvePermissionMode(modeId?: string): PermissionMode {
  return (modeId ?? DEFAULT_MODE_ID) as PermissionMode
}

function resolveThinkingLevel(level?: string): ClaudeThinkingLevel {
  switch (level) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return level
    default:
      return DEFAULT_THINKING_LEVEL
  }
}

export function buildClaudeRuntimeSettings(params: RuntimeSessionParams): ClaudeRuntimeSettings {
  const cliPath = getRuntimeHost().resolveCliPath('claude-code')
  if (!cliPath) {
    throw new Error('Claude Code CLI not configured. Set the path in Settings.')
  }

  const systemPromptAppend = buildSystemPromptAppend(params.instructions)
  const permissionMode = resolvePermissionMode(params.modeId)
  const thinkingLevel = resolveThinkingLevel(params.thinkingLevel)
  const env = buildRuntimeEnv(params.env)
  // Tag SDK-spawned sessions with the `cli` entrypoint so Claude Code's
  // interactive `/resume` picker lists them — it hides `sdk-ts` sessions by
  // default. The SDK only fills CLAUDE_CODE_ENTRYPOINT when unset, so setting
  // it here wins; respect an explicit override from the session env.
  if (!env.CLAUDE_CODE_ENTRYPOINT) {
    env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  }

  return {
    modelId: normalizeModelId(params.modelId),
    cwd: params.cwd,
    permissionMode,
    thinkingLevel,
    fastMode: params.serviceTier === 'fast',
    resume: params.sessionId,
    pathToClaudeCodeExecutable: cliPath,
    settingSources: ['user', 'project', 'local'],
    persistSession: true,
    includePartialMessages: true,
    enableFileCheckpointing: true,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    allowedTools: [
      'mcp__memory__memory_search',
      'mcp__memory__memory_upsert',
      'mcp__external_agent__external_agent_run',
      'mcp__workspace_chat__send_message',
      'mcp__workspace_chat__check_messages',
      'mcp__workspace_chat__read_history',
      'mcp__workspace_chat__list_server',
      'mcp__workspace_chat__upload_file',
      'mcp__workspace_chat__view_file',
      'mcp__taskboard__list_project_tasks',
      'mcp__taskboard__get_project_task',
      'mcp__taskboard__create_project_task',
      'mcp__taskboard__dispatch_project_task',
      'mcp__taskboard__update_project_task',
      'mcp__taskboard__comment_project_task',
      // im_chat is the mate agent's reply channel to humans; treat it as
      // infra (like memory), not a user-decision point. Without this, every
      // message the agent sends back would raise an approval prompt.
      'mcp__im_chat__send_message',
      'mcp__im_chat__check_messages',
      'mcp__im_chat__read_history',
      // team_inbox is point-to-point agent-to-agent messaging. Treat as infra
      // so collaboration does not require user approval on every message.
      'mcp__team_inbox__send_to_agent',
      'mcp__team_inbox__inbox_check',
      'mcp__team_inbox__inbox_read_history',
      'mcp__team_inbox__list_team_peers',
      'mcp__team_inbox__list_agents',
    ],
    disallowedTools: permissionMode === 'bypassPermissions' ? ['EnterPlanMode'] : [],
    mcpServers: params.mcpServers as Record<string, McpServerConfig> | undefined,
    env,
    systemPrompt: systemPromptAppend
      ? {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptAppend,
        }
      : undefined,
    extraArgs: { 'replay-user-messages': null },
  }
}
