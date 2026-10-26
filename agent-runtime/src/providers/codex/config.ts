import type {
  ApprovalMode,
  ApprovalsReviewer,
  CodexAppServerSettings,
  PermissionProfileId,
  ReasoningEffort,
  SandboxMode,
} from './sdk/types/settings.js'
import type {
  CollaborationMode,
  ProtocolApprovalPolicy,
  ProtocolSandboxMode,
  ProtocolSandboxPolicy,
  TurnStartParams,
} from './sdk/protocol/index.js'

export const REASONING_EFFORT_MAP: Record<string, ReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

export const CODEX_MODE_IDS = ['requestApproval', 'approveForMe', 'fullAccess', 'plan'] as const
export type CodexModeId = typeof CODEX_MODE_IDS[number]

export const CODEX_DEFAULT_MODE_ID: CodexModeId = 'requestApproval'
export const CODEX_PLAN_MODE_ID: CodexModeId = 'plan'

interface CodexModeConfig {
  approvalMode: ApprovalMode
  sandboxMode: SandboxMode
  approvalsReviewer: ApprovalsReviewer
  defaultPermissions: PermissionProfileId
}

export const MODES_CONFIG: Record<CodexModeId, CodexModeConfig> = {
  requestApproval: {
    approvalMode: 'on-request',
    sandboxMode: 'workspace-write',
    approvalsReviewer: 'user',
    defaultPermissions: ':workspace',
  },
  approveForMe: {
    approvalMode: 'on-request',
    sandboxMode: 'workspace-write',
    approvalsReviewer: 'auto_review',
    defaultPermissions: ':workspace',
  },
  fullAccess: {
    approvalMode: 'on-request',
    sandboxMode: 'danger-full-access',
    approvalsReviewer: 'user',
    defaultPermissions: ':danger-full-access',
  },
  plan: {
    approvalMode: 'on-request',
    sandboxMode: 'read-only',
    approvalsReviewer: 'user',
    defaultPermissions: ':read-only',
  },
}

/**
 * Codex's own knobs, passed through as they are. Each one set here overrides
 * what the `mode` preset would pick, for as long as the session lives (a mode
 * switch keeps them).
 */
export interface CodexOptions {
  approvalPolicy?: ApprovalMode
  sandbox?: SandboxMode
  /** Who answers approvals: the user, or Codex's own reviewer. */
  approvalsReviewer?: ApprovalsReviewer
  permissionProfile?: PermissionProfileId
  /**
   * Servers from the user's own `~/.codex/config.toml` this session must not
   * load — typically because the host mounts its own under another name, and
   * the user's copy would let the model route around it. Names only.
   */
  disabledMcpServers?: string[]
  /**
   * Servers among `mcpServers` whose tools run without an approval step — the
   * host's own, which carry its own policy. Under `approveForMe` Codex's
   * reviewer otherwise judges each call, and it can't tell the host from an
   * outside destination: it turned down a heartbeat's report to the host as
   * "sending private data to an unverified recipient". Names only.
   */
  approvedMcpServers?: string[]
}

/** Codex's options block on `createSession`. */
export interface CodexSessionOptions {
  codex?: CodexOptions
}

export const DEFAULT_THREAD_MODE = 'persistent' as const

export function resolveCodexModeId(modeId?: string): CodexModeId {
  return CODEX_MODE_IDS.includes(modeId as CodexModeId)
    ? (modeId as CodexModeId)
    : CODEX_DEFAULT_MODE_ID
}

export function resolveCodexModeConfig(modeId?: string): CodexModeConfig {
  return MODES_CONFIG[resolveCodexModeId(modeId)]
}

export function mapApprovalMode(mode?: ApprovalMode): ProtocolApprovalPolicy {
  const validModes: ProtocolApprovalPolicy[] = ['never', 'on-request', 'on-failure', 'untrusted']
  const normalized = mode?.toLowerCase() ?? 'on-request'
  return validModes.includes(normalized as ProtocolApprovalPolicy)
    ? (normalized as ProtocolApprovalPolicy)
    : 'on-request'
}

export function mapSandboxMode(mode?: SandboxMode): ProtocolSandboxMode {
  const validModes: ProtocolSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
  const normalized = mode?.toLowerCase() ?? 'workspace-write'
  if (normalized === 'full-access') return 'danger-full-access'
  return validModes.includes(normalized as ProtocolSandboxMode)
    ? (normalized as ProtocolSandboxMode)
    : 'workspace-write'
}

export function toSandboxPolicy(mode: ProtocolSandboxMode, writableRoots: readonly string[] = []): ProtocolSandboxPolicy {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly' }
    case 'workspace-write':
      return writableRoots.length ? { type: 'workspaceWrite', writableRoots: [...writableRoots] } : { type: 'workspaceWrite' }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
  }
}

export function mapReasoningEffort(effort?: ReasoningEffort): TurnStartParams['effort'] {
  if (!effort || effort === 'none') return undefined
  return effort
}

export function buildDeveloperInstructions(
  settings: CodexAppServerSettings,
  instructions?: string,
): string | undefined {
  const parts = [settings.baseInstructions, instructions].filter(Boolean) as string[]
  return parts.length ? parts.join('\n\n') : undefined
}

export function sanitizeCollaborationMode(
  mode?: CollaborationMode,
): CollaborationMode | undefined {
  if (!mode) return undefined
  const settings = Object.fromEntries(
    Object.entries(mode.settings ?? {}).filter(([, value]) => value !== undefined),
  ) as CollaborationMode['settings']

  return {
    mode: mode.mode,
    settings,
  }
}

export function materializeCollaborationMode(
  mode: CollaborationMode | undefined,
  defaults: {
    model: string
    reasoningEffort: string | null
    developerInstructions: string | null
  },
): CollaborationMode | undefined {
  const sanitized = sanitizeCollaborationMode(mode)
  if (!sanitized) return undefined

  return {
    mode: sanitized.mode,
    settings: {
      model:
        typeof sanitized.settings.model === 'string' && sanitized.settings.model.trim().length > 0
          ? sanitized.settings.model
          : defaults.model,
      reasoning_effort:
        sanitized.settings.reasoning_effort === undefined
          ? defaults.reasoningEffort
          : sanitized.settings.reasoning_effort,
      developer_instructions:
        sanitized.settings.developer_instructions === undefined
          ? defaults.developerInstructions
          : sanitized.settings.developer_instructions,
    },
  }
}
