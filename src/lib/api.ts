import * as httpClient from './api-client.js'
import { apiAuthHeaders, asRecord, getBaseUrl, request, withApiTokenQuery } from './api-client.js'
import * as terminalWs from './terminal-ws.js'
import type { CronjobTask, CronjobUpsertInput, CronjobExecutionHistoryItem } from '@/types/cronjob'
import type {
  InstalledSkill,
  SkillDetail,
  SkillInfo,
  SkillInstallInput,
  SkillInstallTargetResult,
  SkillRemoveInput,
  SkillScope,
  SkillUpdateInput,
} from '@/types/skill'
import type { CanvasWorkflow, CanvasWorkflowListItem, CanvasWorkflowRun, CreateCanvasWorkflowInput, UpdateCanvasWorkflowInput } from '@/types/canvas-workflow'
import type { UIMessage } from 'ai'
import type { DetailedContextUsage } from '@/types/context-usage'
import type { ClaudeRateLimits } from '@/components/editor/utils/chatMetadata'
import type { CodexGoal } from '@/types/goal'
import type { ExtensionMarketplaceDTO, OperonExtensionDTO } from '@/types/extension'
import type { PeersConfig, PeersRosterDTO } from '@/types/peers'
import type { MarketplaceBrowseResult, OperonMarketplaceDetailsDTO, OperonMarketplaceInfoDTO, OperonMcpAuthServerDTO, OperonMcpToolDTO, OperonPluginDTO, OperonPluginInfoDTO } from '@/types/plugin'
import type { MobilePairingSummary } from '@/types/mobile'
import type {
  IMChannelBinding,
  IMMessageRecord,
  IMProviderCreateInput,
  IMProviderRecord,
  IMProviderUpdateInput,
  IMSourceMeta,
} from '@/types/im'
import type { TaskArtifact, ArtifactKind } from '@/types/task'
import type { RemotePairingQrPayload, RemotePairingStatus } from '@shared/e2ee/protocol'

export type ProjectDTO = {
  id: number
  name: string
  rootPath: string
  createdAt: number
  updatedAt: number
}

export type WorkspaceDTO = {
  id: number
  projectId: number
  name: string
  branchName: string
  worktreePath: string
  createdAt: number
  updatedAt: number
}

export type McpStdioEntry = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
export type McpHttpEntry = { type: 'http'; url: string; headers?: Record<string, string> }
export type McpSseEntry = { type: 'sse'; url: string; headers?: Record<string, string> }
export type McpServerEntry = McpStdioEntry | McpHttpEntry | McpSseEntry

/** Why a rewind left a file alone. See the server's `RewindSkipReason`. */
export type RewindSkipReason =
  /** Its content changed after this chat last wrote it. */
  | 'modified-by-others'
  /** Another chat wrote to the workspace during the turn that produced it. */
  | 'concurrent-turn'
  /** Its turn never recorded an end snapshot, so its changes cannot be bounded. */
  | 'unbounded-turn'

export interface RewindSkippedFile {
  /** Project-relative path. */
  path: string
  reason: RewindSkipReason
}

/**
 * Two error conventions coexist on the server and the split is deliberate here.
 *
 * `get`/`post`/… reject on any non-2xx. Use them for endpoints whose declared
 * type is the success shape — the caller has no `error` field to inspect, so a
 * silently-passed-through failure body just becomes `undefined` fields and blows
 * up further downstream (spreading a 500's `{ error }` as `{ cronjobs }` threw
 * "cronjobs is not iterable" out of a `useMemo`, one render later, which the
 * root ErrorBoundary turned into a blank window).
 *
 * `softGet`/`softPost`/… pass a non-2xx body straight through when it carries
 * the server's own `{ error }` shape. Use them — and only them — for endpoints
 * that model failure in their return type, either as an optional field
 * (`{ …; error?: string }`) or as a union arm (`Success | { error: string }`),
 * because there reporting the failure is the caller's job. Routes like
 * `plugins.ts` mix 200-with-error and 4xx-with-error for the same class of
 * failure, so those callers must not have the status decide whether their
 * `.error` check runs at all.
 *
 * Rule of thumb: the type mentions `error` ⇒ `soft*`. Otherwise ⇒ plain.
 */
function get<T>(path: string): Promise<T> {
  return request<T>(path)
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

/**
 * Resolves with the parsed body whenever it is JSON that could plausibly be the
 * caller's declared type — including an error body on a 4xx/5xx. Still throws
 * when the response can't answer the caller at all (HTML from a tunnel 502,
 * Hono's plain-text 404, an empty body), because those would otherwise reach the
 * caller as `undefined` and defeat the point of checking `.error`.
 */
async function softRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
      ...(options?.headers as Record<string, string> | undefined),
    },
  })
  const body = asRecord(await res.json().catch(() => null))
  if (body === null) {
    throw new Error(res.ok ? `Malformed response from ${path}` : `${res.status} ${res.statusText}`)
  }
  return body as T
}

function softGet<T>(path: string): Promise<T> {
  return softRequest<T>(path)
}

function softPost<T>(path: string, body: unknown): Promise<T> {
  return softRequest<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

// No softPut/softDel: no endpoint declaring `error?` uses those verbs today.
// Add them next to softRequest if one does.

type PermissionOutcomeKind = 'allow' | 'deny' | 'allowAlways'
type PermissionOutcome =
  | PermissionOutcomeKind
  | { outcome: PermissionOutcomeKind; reason?: string; updatedInput?: Record<string, unknown> }

export type { PermissionOutcome, PermissionOutcomeKind }

export type MemoryType =
  | 'user'
  | 'entities'
  | 'events'
  | 'cases'

export interface MemoryPage {
  type: MemoryType
  slug: string
  truth: string
  revision: number
  updated_at: number
}

export interface MemoryTimelineEntry {
  id: number
  page_type: MemoryType
  page_slug: string
  entry: string
  occurred_at: number | null // null = event time unknown
  created_at: number
}

export interface MemoryMaintenanceConfig {
  enabled: boolean
  scheduleTime: string
  providerId?: string
  modelId?: string
  layer1Enabled: boolean
  maxSessionsPerRun: number
  updatedAt: number
}

export interface MemoryMaintenanceRun {
  id: number
  startedAt: number
  finishedAt?: number
  layer: 'extract' | 'consolidate' | 'full'
  providerId?: string
  modelId?: string
  sessionsProcessed: number
  chunksProcessed: number
  memoriesWritten: number
  memoriesMerged: number
  tokensInput: number
  tokensOutput: number
  status: 'running' | 'success' | 'error' | 'aborted'
  trigger: 'scheduled' | 'manual'
  error?: string
}

export interface MemorySearchResult {
  type: MemoryType
  slug: string
  truth: string
  revision: number
  updated_at: number
  /**
   * Ordering signal within one response — cross-encoder score when the local
   * reranker ran, RRF fusion score when it wasn't available. Optional: the
   * server omits it on responses that aren't ranked.
   */
  score?: number
  timeline: Array<{
    id: number
    occurred_at: number | null // null = event time unknown
    entry: string
    matched: boolean
  }>
}

/**
 * Unified API facade - all methods go through HTTP/WS/SSE.
 * Only selectFolder remains IPC (Electron native dialog).
 */
export interface WorkflowAgentView {
  index: number
  taskId: string
  label: string
  phase?: string
  state: 'queued' | 'running' | 'done' | 'error'
  resultPreview?: string
  error?: string
  /** Which of the user's agents ran this step — the whole point of the workflow. */
  agentType?: string
  modelId?: string
  startedAt?: number
  endedAt?: number
  /** This agent's recorded output hit the byte cap; its tail is missing. */
  truncated?: boolean
}

/**
 * A sub-agent request that is blocking the run until a human answers.
 *
 * Shown on the run card itself: that is where the user launched this work and is
 * watching it. The approval inbox carries the same request as a fallback, and
 * both answer through the ordinary permission response.
 */
export interface WorkflowPendingApprovalView {
  approvalId: string
  /** Sub-agent that asked, e.g. 'codex-a3'. */
  agentId: string
  toolName: string
  /** The asking tool's input — an AskUserQuestion's `questions`, with options. */
  toolInput?: unknown
  requestedAt: number
}

export interface WorkflowRunView {
  runId: string
  taskId: string
  /** Chat that launched the run (result routing / completion gating). */
  chatId?: number | null
  name: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  phases: { index: number; title: string; kind?: 'normal' | 'child' }[]
  agents: WorkflowAgentView[]
  /**
   * Sub-agents blocked waiting on a human. Always empty for a run this node is
   * not executing: the promise such a request resolves lives in the process that
   * created it, so after a restart there is nothing left to answer.
   */
  pendingApprovals?: WorkflowPendingApprovalView[]
  /** `log()` output and host notices — narration, not errors. */
  logs?: string[]
  /** Steps the engine reported as failed. Non-empty means something went wrong. */
  failures: string[]
  startedAt: number
  endedAt?: number
  error?: string
  hasResult: boolean
}

/**
 * One frame of a workflow feed (`/ai/workflow/feed`, `/ai/workflow/run/:id/feed`).
 *
 * The server folds run views before sending them, so the client never
 * reconstructs run state from events — it only accumulates sub-agent `chunk`
 * frames, through the same reducer the rest of the app uses. `id` is the event
 * log position, passed back as `since` on reconnect.
 */
export type WorkflowFeedFrame =
  | { t: 'sync'; id: number; runs?: WorkflowRunView[]; run?: WorkflowRunView }
  | { t: 'run'; id: number; run: WorkflowRunView; kind?: WorkflowFeedEventKind }
  | { t: 'chunk'; id: number; runId: string; index: number; chunks: unknown[] }

/**
 * The event kind behind a `run` frame, as the server's log spells it.
 *
 * Only `started` is acted on (it is what separates a new run from the history in
 * the opening snapshot); the rest are listed so the union documents what can
 * arrive rather than degenerating to `string`. It is optional because a feed
 * from an older node does not send it.
 */
export type WorkflowFeedEventKind =
  | 'started'
  | 'phase'
  | 'agent'
  | 'truncated'
  | 'approval'
  | 'approval-resolved'
  | 'log'
  | 'settled'

export const api = {
  // --- Git (HTTP) ---
  gitStatus: httpClient.gitStatus,
  gitDiff: httpClient.gitDiff,
  gitShow: httpClient.gitShow,
  gitStage: httpClient.gitStage,
  gitStageAll: httpClient.gitStageAll,
  gitUnstage: httpClient.gitUnstage,
  gitUnstageAll: httpClient.gitUnstageAll,
  gitListRemotes: httpClient.gitListRemotes,
  gitCommit: httpClient.gitCommit,
  gitGenerateCommitMessage: httpClient.gitGenerateCommitMessage,
  gitPush: httpClient.gitPush,
  gitPushStatus: httpClient.gitPushStatus,
  gitBranches: httpClient.gitBranches,
  gitCommits: httpClient.gitCommits,
  gitDefaultBaseBranch: httpClient.gitDefaultBaseBranch,
  gitMergeBase: httpClient.gitMergeBase,
  gitCommitParent: httpClient.gitCommitParent,
  gitDiffRange: httpClient.gitDiffRange,
  gitFileDiffRange: httpClient.gitFileDiffRange,
  gitWorktreeList: httpClient.gitWorktreeList,
  gitWorktreeAdd: httpClient.gitWorktreeAdd,
  gitWorktreeRemove: httpClient.gitWorktreeRemove,
  gitRestore: httpClient.gitRestore,
  gitRestoreAll: httpClient.gitRestoreAll,
  gitDiffStat: httpClient.gitDiffStat,
  gitStatusWithDiffStat: httpClient.gitStatusWithDiffStat,

  // --- File System (HTTP for CRUD, SSE for watch) ---
  readDir: httpClient.readDir,
  findPaths: httpClient.findPaths,
  readFile: httpClient.readFile,
  getFileUrl: httpClient.getFileUrl,
  writeFile: httpClient.writeFile,
  saveTempFile: httpClient.saveTempFile,
  exists: httpClient.exists,
  getHomePath: httpClient.getHomePath,
  stat: httpClient.stat,

  // IPC-only (Electron native dialog)
  selectFolder: () => window.electronAPI?.selectFolder() ?? Promise.resolve(null),

  // --- Chat History (HTTP) ---
  chatHistoryGet: httpClient.chatHistoryGet,
  chatHistoryCreate: httpClient.chatHistoryCreate,
  chatHistoryPatch: httpClient.chatHistoryPatch,
  chatHistoryClear: httpClient.chatHistoryClear,
  chatHistoryList: httpClient.chatHistoryList,
  chatHistorySideCreate: httpClient.chatHistorySideCreate,

  // --- AI turn control (HTTP) ---
  aiAbort: httpClient.aiAbort,

  // --- Terminal (WebSocket) ---
  createTerminal: terminalWs.createTerminal,
  writeTerminal: terminalWs.writeTerminal,
  resizeTerminal: terminalWs.resizeTerminal,
  closeTerminal: terminalWs.closeTerminal,
  onTerminalData: terminalWs.onTerminalData,
  onTerminalExit: terminalWs.onTerminalExit,

  // --- AI Chat (HTTP + SSE) ---
  aiPermissionResponse: (payload: { id: string; outcome: PermissionOutcome; chatId: number }) =>
    post<{ success: boolean }>('/ai/permission-response', payload),
  aiPendingApprovals: (chatId: number) =>
    get<{
      approvals: Array<{
        approvalId: string
        toolName: string
        requestedAt: number
        /** Set when a detached workflow sub-agent asked, not this chat's own turn. */
        origin?: string
        /** The asking tool's input (AskUserQuestion questions), sub-agents only. */
        toolInput?: unknown
      }>
    }>(
      `/ai/pending-approvals/${chatId}`,
    ),
  aiWorkflowRuns: (limit = 50) =>
    get<{ runs: WorkflowRunView[] }>(`/ai/workflow/runs?limit=${limit}`),
  /** One sub-agent's recorded output — for expanding an agent on a finished run. */
  aiWorkflowAgentChunks: (runId: string, agentIndex: number) =>
    get<{ chunks: unknown[]; truncated: boolean }>(
      `/ai/workflow/run/${encodeURIComponent(runId)}/agent/${agentIndex}/chunks`,
    ),
  /** The script a run was launched with — fetched on demand, never on the list. */
  aiWorkflowScript: (runId: string) =>
    get<{ script?: string; args?: unknown }>(
      `/ai/workflow/run/${encodeURIComponent(runId)}/script`,
    ),
  aiWorkflowResult: (runId: string) =>
    get<{ hasResult: boolean; result?: unknown }>(
      `/ai/workflow/run/${encodeURIComponent(runId)}/result`,
    ),
  aiWorkflowStop: (runId: string) =>
    post<{ stopped: boolean }>(`/ai/workflow/run/${encodeURIComponent(runId)}/stop`, {}),
  aiWorkflowFeedUrl: async (limit = 30) => `${await getBaseUrl()}/ai/workflow/feed?limit=${limit}`,
  /** Presence for every chat on one stream — see `lib/live-turn-events.ts`. */
  aiLiveStatusStreamUrl: async () => `${await getBaseUrl()}/ai/chat/live-status`,
  /** `since` resumes an interrupted connection; omit it to replay the run's whole log. */
  aiWorkflowRunFeedUrl: async (runId: string, since?: number) => {
    const baseUrl = await getBaseUrl()
    const query = since != null ? `?since=${since}` : ''
    return `${baseUrl}/ai/workflow/run/${encodeURIComponent(runId)}/feed${query}`
  },
  aiCCDynamicSet: (payload: { chatId: number; modelId?: string; modeId?: string; thinkingLevel?: string }) =>
    softPost<{ success: boolean; error?: string }>('/ai/cc/dynamic-set', payload),
  aiCompact: (payload: { chatId: number; modelId: string; providerId?: string; workspaceId?: number }) =>
    softPost<{ success: boolean; originalMessageCount?: number; newMessageCount?: number; error?: string }>('/ai/compact', payload),
  aiInject: (payload: { chatId: number; content: string; turnMessageId?: string }) =>
    softPost<{ success: boolean; error?: string; message?: UIMessage }>('/ai/inject', payload),
  aiSessionCleanup: (chatId: number) =>
    post<{ success: boolean }>('/ai/session/cleanup', { chatId }),
  getProviders: () =>
    get<{ id: string; label: string; logo: string; available: boolean }[]>('/ai/providers'),
  getProviderModels: (providerId: string) =>
    get<any>(`/ai/providers/${encodeURIComponent(providerId)}/models`),
  /**
   * Rewind this chat's files to a checkpoint. Files another chat changed come
   * back in `skipped` instead of being reverted; re-call with `force` to revert
   * those too once the user confirms.
   */
  aiRewindToCheckpoint: (chatId: number, messageUid: string, cwd: string, force?: boolean) =>
    post<{
      success: boolean
      message?: string
      filesChanged?: string[]
      skipped?: RewindSkippedFile[]
      backupSnapshotId?: string
    }>('/ai/rewind', { chatId, messageUid, cwd, force }),
  /** `files` are the paths the rewind reported changing, so other chats' edits stay put. */
  aiUndoRewind: (backupSnapshotId: string, cwd: string, files?: string[]) =>
    post<{ success: boolean; message?: string }>('/ai/undo-rewind', { backupSnapshotId, cwd, files }),
  aiGetCheckpoints: (chatId: number) =>
    get<{ checkpoints: Record<string, { snapshotId: string; createdAt: number }> }>(`/ai/checkpoints/${chatId}`),
  aiGetTurnDiffs: (chatId: number, cwd: string) =>
    get<{
      turns: Array<{
        messageUid: string
        snapshotId: string
        files: Array<{ path: string; status: string; additions: number; deletions: number }>
      }>
    }>(`/ai/turn-diffs/${chatId}?cwd=${encodeURIComponent(cwd)}`),
  aiGetTurnFileDiffs: (chatId: number, cwd: string, messageUid?: string) =>
    get<{
      snapshotId: string | null
      files: Array<{ path: string; status: string; diff: string }>
    }>(`/ai/turn-file-diffs/${chatId}?cwd=${encodeURIComponent(cwd)}${messageUid ? `&messageUid=${encodeURIComponent(messageUid)}` : ''}`),
  aiGetContextUsage: (chatId: number) =>
    softGet<{ success: boolean; data?: DetailedContextUsage; error?: string }>(`/ai/context-usage/${chatId}`),
  aiGetClaudeUsage: () =>
    softGet<{ success: boolean; data?: ClaudeRateLimits; error?: string }>('/ai/claude-usage'),
  aiGetGoal: (chatId: number) =>
    softGet<{ success: boolean; goal?: CodexGoal | null; error?: string }>(`/ai/goal/${chatId}`),
  aiClearGoal: (chatId: number) =>
    softPost<{ success: boolean; error?: string }>('/ai/goal/clear', { chatId }),
  aiSetGoalStatus: (chatId: number, status: 'active' | 'paused') =>
    softPost<{ success: boolean; goal?: CodexGoal | null; error?: string }>('/ai/goal/status', { chatId, status }),
  // Generic operon runtime-control (MCP / cron / tasks / subagents / skills /
  // plugins). Typed wrappers + DTOs live in components/editor/agent/agentControl.ts.
  aiAgentControl: <T = unknown>(payload: { chatId: number; method: string; params?: unknown }) =>
    softPost<{ success: boolean; data?: T; error?: string }>('/ai/agent-control', payload),

  // --- Provider Configs (HTTP) ---
  providerConfigGetAll: () =>
    get<{ configs: Record<string, { hasApiKey: boolean; apiKey?: string; baseUrl?: string; enabled: boolean; manualModels?: string[] }> }>('/provider-configs'),
  providerConfigSave: (providerId: string, config: { apiKey?: string; baseUrl?: string; enabled?: boolean; manualModels?: string[] }) =>
    put<{ success: boolean }>(`/provider-configs/${encodeURIComponent(providerId)}`, config),
  providerConfigFetchModels: (providerId: string, config?: { apiKey?: string; baseUrl?: string }) =>
    softPost<{ models?: Array<{ id: string; name: string; description?: string }>; error?: string }>(
      `/provider-configs/${encodeURIComponent(providerId)}/models`,
      config ?? {}
    ),

  // --- Env Vars (HTTP) ---
  envGetAll: () =>
    get<{ vars: Record<string, string> }>('/env'),
  envSave: (vars: Record<string, string>) =>
    put<{ success: boolean }>('/env', { vars }),

  // --- Embedding Config (HTTP) ---
  embeddingGetConfig: () =>
    get<{ enabled: boolean; dimensions?: number }>('/embedding/config'),
  embeddingUpdateConfig: (config: Record<string, unknown>) =>
    put<{ enabled: boolean; dimensions?: number }>('/embedding/config', config),
  embeddingGetStatus: () =>
    get<{
      gpuType: string | false
      gpuDevices: string[]
      vram?: { total: number; used: number; free: number }
      cpuCores: number
      models: {
        embed: { name: string; uri: string; downloaded: boolean; sizeBytes: number }
        rerank: { name: string; uri: string; downloaded: boolean; sizeBytes: number }
      }
      downloading: boolean
    }>('/embedding/status'),
  embeddingTest: (text?: string) =>
    post<{ success: boolean; dimensions: number }>('/embedding/test', { text }),
  embeddingDownload: () =>
    post<{ started: boolean }>('/embedding/download', {}),

  // --- Memory (HTTP) ---
  memoryList: (type?: MemoryType, limit?: number) => {
    const qs = new URLSearchParams()
    if (type) qs.set('type', type)
    if (limit) qs.set('limit', String(limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return get<Array<MemoryPage>>(`/memory/pages${suffix}`)
  },
  memoryGet: (type: MemoryType, slug: string) =>
    get<MemoryPage & { timeline: MemoryTimelineEntry[] }>(`/memory/pages/${type}/${slug}`),
  memoryDelete: (type: MemoryType, slug: string) =>
    del<{ success: boolean }>(`/memory/pages/${type}/${slug}`),
  memorySearch: (query: string, types?: MemoryType[], limit?: number) =>
    post<Array<MemorySearchResult>>('/memory/search', { query, types, limit }),

  // --- Memory Maintenance (HTTP) ---
  memoryMaintenanceGetConfig: () =>
    get<MemoryMaintenanceConfig>('/memory-maintenance/config'),
  memoryMaintenanceUpdateConfig: (updates: Partial<Omit<MemoryMaintenanceConfig, 'updatedAt'>>) =>
    patch<MemoryMaintenanceConfig>('/memory-maintenance/config', updates),
  memoryMaintenanceListRuns: (limit?: number) =>
    get<MemoryMaintenanceRun[]>(`/memory-maintenance/runs${limit ? `?limit=${limit}` : ''}`),
  memoryMaintenanceGetRunLog: (id: number) =>
    softGet<{ content: string; error?: string }>(`/memory-maintenance/runs/${id}/log`),
  memoryMaintenanceRunNow: () =>
    softPost<{ runId?: number; status: string; error?: string }>('/memory-maintenance/run', {}),
  memoryMaintenanceAbort: () =>
    softPost<{ success?: boolean; error?: string }>('/memory-maintenance/abort', {}),

  // --- Cronjobs (HTTP) ---
  cronjobList: () =>
    get<{ cronjobs: CronjobTask[] }>('/cronjobs'),
  cronjobCreate: (input: CronjobUpsertInput) =>
    post<{ cronjob: CronjobTask }>('/cronjobs', input),
  cronjobUpdate: (id: number, input: CronjobUpsertInput) =>
    put<{ cronjob: CronjobTask }>(`/cronjobs/${id}`, input),
  cronjobDelete: (id: number) =>
    del<{ success: boolean }>(`/cronjobs/${id}`),
  cronjobRun: (id: number) =>
    softPost<{ success: boolean; cronjob?: CronjobTask; error?: string }>(`/cronjobs/${id}/run`, {}),
  cronjobHistory: (id: number) =>
    get<{ history: CronjobExecutionHistoryItem[] }>(`/cronjobs/${id}/history`),

  // --- CLI Paths ---
  cliPathsGet: () =>
    get<Record<string, { path?: string; resolvedPath?: string; available: boolean; source: 'manual' | 'auto' | 'missing'; command: string }>>('/cli-paths'),
  cliPathSet: (adapterId: string, path: string | undefined) =>
    put<{
      success: boolean
      available: boolean
      info: {
        path?: string
        resolvedPath?: string
        available: boolean
        source: 'manual' | 'auto' | 'missing'
        command: string
      }
    }>(`/cli-paths/${encodeURIComponent(adapterId)}`, { path }),
  /**
   * Runs `<cli> --version`. Separate from cliPathsGet because it spawns the CLI —
   * call it for the adapter on screen, not for all of them up front.
   */
  cliPathVersionProbe: (adapterId: string) =>
    get<{ version?: string; error?: string; warning?: string }>(
      `/cli-paths/${encodeURIComponent(adapterId)}/version`,
    ),

  // --- Skills (HTTP) ---
  // `workspacePath` is sent even for global listings: it's what lets the server flag
  // global skills that a project copy of the same name shadows.
  skillListInstalled: (scope: SkillScope = 'global', workspacePath?: string) =>
    softGet<{ skills?: InstalledSkill[]; error?: string }>(
      `/skills?scope=${scope}${workspacePath ? `&workspacePath=${encodeURIComponent(workspacePath)}` : ''}`,
    ),
  skillListAvailable: (source: string, refresh = false) =>
    softGet<{ skills?: SkillInfo[]; error?: string }>(
      `/skills/available?source=${encodeURIComponent(source)}${refresh ? '&refresh=1' : ''}`,
    ),
  skillDetail: (skillName: string, source?: string, scope: SkillScope = 'global', workspacePath?: string) =>
    softGet<{ detail?: SkillDetail; error?: string }>(
      `/skills/detail?skillName=${encodeURIComponent(skillName)}${source ? `&source=${encodeURIComponent(source)}` : ''}` +
        `&scope=${scope}${workspacePath ? `&workspacePath=${encodeURIComponent(workspacePath)}` : ''}`,
    ),
  skillInstall: (input: SkillInstallInput) =>
    softPost<{ success: boolean; output?: string; error?: string; targets?: SkillInstallTargetResult[] }>(
      '/skills/install',
      input,
    ),
  skillUpdate: (input: SkillUpdateInput) =>
    softPost<{
      success: boolean
      output?: string
      error?: string
      /** Set when the installed copy has local edits — retry with `force` to overwrite. */
      needsForce?: boolean
      targets?: SkillInstallTargetResult[]
    }>('/skills/update', input),
  skillRemove: (input: SkillRemoveInput) =>
    softPost<{ success: boolean; output?: string; error?: string }>('/skills/remove', input),

  // --- Canvas Workflows (HTTP) ---
  canvasWorkflowList: (workspaceId?: number) =>
    get<{ workflows: CanvasWorkflowListItem[] }>(`/canvas-workflows${workspaceId !== undefined ? `?workspaceId=${workspaceId}` : ''}`),
  canvasWorkflowGet: (id: number) =>
    get<{ workflow: CanvasWorkflow }>(`/canvas-workflows/${id}`),
  canvasWorkflowCreate: (input: CreateCanvasWorkflowInput) =>
    post<{ workflow: CanvasWorkflow }>('/canvas-workflows', input),
  canvasWorkflowUpdate: (id: number, input: UpdateCanvasWorkflowInput) =>
    put<{ workflow: CanvasWorkflow }>(`/canvas-workflows/${id}`, input),
  canvasWorkflowDelete: (id: number) =>
    del<{ success: boolean }>(`/canvas-workflows/${id}`),
  canvasWorkflowExecute: (id: number) =>
    post<{ runId: number }>(`/canvas-workflows/${id}/execute`, {}),
  canvasWorkflowGetRun: (runId: number) =>
    get<{ run: CanvasWorkflowRun }>(`/canvas-workflows/runs/${runId}`),
  canvasWorkflowListRuns: (id: number, limit?: number) =>
    get<{ runs: CanvasWorkflowRun[] }>(`/canvas-workflows/${id}/runs${limit ? `?limit=${limit}` : ''}`),

  // --- Projects (HTTP) ---
  projectList: () =>
    get<{ projects: ProjectDTO[] }>('/projects'),
  /**
   * Projects with their workspaces embedded — one request instead of
   * `projectList()` followed by an `workspaceList()` per project. Prefer this
   * anywhere the whole tree is needed: on the web build each request is a WAN
   * round trip through the broker tunnel, so the 1 + N version left the sidebar
   * blank for as long as the slowest workspace fetch took.
   */
  projectListWithWorkspaces: () =>
    get<{ projects: (ProjectDTO & { workspaces: WorkspaceDTO[] })[] }>('/projects?include=workspaces'),
  projectGet: (id: number) =>
    get<{ project: ProjectDTO }>(`/projects/${id}`),
  projectCreate: (input: { name: string; rootPath: string }) =>
    post<{ project: ProjectDTO }>('/projects', input),
  projectDelete: (id: number) =>
    del<{ success: boolean }>(`/projects/${id}`),
  workspaceList: (projectId: number) =>
    get<{ workspaces: WorkspaceDTO[] }>(`/projects/${projectId}/workspaces`),
  workspaceCreate: (projectId: number, input: { name: string; branchName: string; worktreePath: string }) =>
    post<{ workspace: WorkspaceDTO }>(`/projects/${projectId}/workspaces`, input),
  workspaceDelete: (id: number) =>
    del<{ success: boolean }>(`/projects/workspaces/${id}`),

  // --- IM Platform (multi-provider, agent-as-bot) ---
  imSourceList: () =>
    get<{ sources: IMSourceMeta[] }>('/admin/im/sources'),
  imProviderList: (filter?: { source?: string; enabled?: boolean }) => {
    const params = new URLSearchParams()
    if (filter?.source) params.set('source', filter.source)
    if (filter?.enabled !== undefined) params.set('enabled', String(filter.enabled))
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return get<{ providers: IMProviderRecord[] }>(`/admin/im/providers${suffix}`)
  },
  imProviderGet: (id: number) =>
    get<{ provider: IMProviderRecord }>(`/admin/im/providers/${id}`),
  imProviderCreate: (input: IMProviderCreateInput) =>
    post<{ provider: IMProviderRecord }>('/admin/im/providers', input),
  imProviderUpdate: (id: number, updates: IMProviderUpdateInput) =>
    put<{ provider: IMProviderRecord }>(`/admin/im/providers/${id}`, updates),
  imProviderDelete: (id: number) =>
    del<{ success: boolean }>(`/admin/im/providers/${id}`),
  imSlackQuickSetupManifest: (input: { displayName: string; description?: string }) =>
    softPost<{ manifest: string } | { error: string }>(
      '/admin/im/slack/quick-setup/manifest',
      input,
    ),
  imTelegramQuickSetupValidate: (input: { token: string }) =>
    softPost<
      | { bot: { id: number; username: string | null; firstName: string; canJoinGroups?: boolean; canReadAllGroupMessages?: boolean } }
      | { error: string }
    >('/admin/im/telegram/quick-setup/validate-token', input),
  imTelegramQuickSetupCreate: (input: {
    token: string
    displayName: string
    description?: string
    mode: 'mate' | 'interactive'
    agentId: number | null
  }) =>
    softPost<
      | {
          provider: IMProviderRecord
          bot: { id: number; username: string | null; firstName: string; canReadAllGroupMessages?: boolean }
          applyWarning: string | null
        }
      | { error: string }
    >('/admin/im/telegram/quick-setup/create-provider', input),
  imTelegramQuickSetupRecheck: (providerId: number) =>
    softPost<
      | { bot: { id: number; username: string | null; firstName: string; canReadAllGroupMessages?: boolean } }
      | { error: string }
    >(`/admin/im/telegram/quick-setup/recheck/${providerId}`, {}),
  imBindingsForAgent: (agentId: number) =>
    get<{ bindings: IMChannelBinding[] }>(`/admin/im/bindings?agentId=${agentId}`),
  imBindingsForProvider: (providerId: number) =>
    get<{ bindings: IMChannelBinding[] }>(`/admin/im/bindings?providerId=${providerId}`),
  imMessageTail: (source: string, sourceChannel: string, opts?: { afterId?: number; beforeId?: number; limit?: number }) => {
    const params = new URLSearchParams({ source, sourceChannel })
    if (opts?.afterId !== undefined) params.set('afterId', String(opts.afterId))
    if (opts?.beforeId !== undefined) params.set('beforeId', String(opts.beforeId))
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    return get<{ messages: IMMessageRecord[] }>(`/admin/im/messages?${params.toString()}`)
  },

  // --- Linear Agent (HTTP) ---
  // ---- Browser Use: remembered browser approvals for agents. Stored under
  //      ~/.operon/browser/, the same file node_repl reads. ----
  browserUseGetApprovals: () =>
    get<{
      allowed: string[]
      denied: string[]
      /** How many approvals past conversations remember. Counts only, no detail;
       *  see server/routes/browser-use.ts for why. */
      rememberedFromConversations: number
      fullCdpAccess: boolean
      configPath: string
      /** Master switch: off means neither the skill nor the node_repl MCP is injected. */
      enabled: boolean
    }>('/browser-use/approvals'),
  browserUseSetEnabled: (enabled: boolean) =>
    post<{ ok: true }>('/browser-use/enabled', { enabled }),

  computerUseGetSettings: () => get<{ enabled: boolean }>('/computer-use/settings'),
  computerUseSetEnabled: (enabled: boolean) =>
    post<{ ok: true }>('/computer-use/enabled', { enabled }),
  /** macOS grants as the engine process sees them (`running: false` = engine off). */
  computerUseGetPermissions: () =>
    get<{
      enabled: boolean
      running: boolean
      accessibility: boolean
      screenRecording: boolean
    }>('/computer-use/permissions'),
  computerUseOpenPermissionSettings: (permission: 'accessibility' | 'screenRecording') =>
    post<{ ok: true }>('/computer-use/permissions/open', { permission }),
  chromeUseGetSettings: () =>
    get<{
      enabled: boolean
      extensionId: string
      chromeInstalled: boolean
      extensionInstalled: boolean
      extensionDisabled: boolean
      profiles: {
        directory: string
        installed: boolean
        enabled: boolean
        unpacked: boolean
        selected: boolean
      }[]
      nativeHostInstalled: boolean
      /** Manifest present but the binary it execs is gone — Chrome only reports this
       *  as a generic connection failure, so the UI has to say it. */
      nativeHostStale: boolean
    }>('/chrome-use/settings'),
  chromeUseSetEnabled: (enabled: boolean) => post<{ ok: true }>('/chrome-use/enabled', { enabled }),
  chromeUseReinstallHost: () =>
    post<{ ok: true; manifestPaths: string[] }>('/chrome-use/reinstall-host', {}),
  browserUseRevokeOrigin: (origin: string) =>
    post<{ ok: true }>('/browser-use/approvals/revoke', { origin }),
  browserUseClearRemembered: () =>
    post<{ ok: true; cleared: number }>('/browser-use/approvals/clear', {}),
  browserUseSetFullCdpAccess: (enabled: boolean) =>
    post<{ ok: true }>('/browser-use/full-cdp-access', { enabled }),

  // ---- SaaS (remote web access) ----
  saasGetStatus: () =>
    get<{
      connected: boolean
      running: boolean
      userId?: string
      nodeId?: string
      label?: string
      loginError?: { code: string; message: string }
    }>(
      '/saas/status',
    ),
  saasLogin: (provider: 'github' | 'apple', label: string) =>
    softPost<{ authorizeUrl?: string; error?: string; code?: string; message?: string }>('/saas/login', { provider, label }),
  saasLogout: () => post<{ success: boolean }>('/saas/logout', {}),
  remoteE2eePairStart: () => post<RemotePairingQrPayload>('/e2ee/pair/start', {}),
  remoteE2eePairSession: (pairingId: string) =>
    get<{ status: RemotePairingStatus['status']; expiresAt?: number; pairing?: MobilePairingSummary }>(
      `/e2ee/pair/session/${encodeURIComponent(pairingId)}`,
    ),
  remoteE2eePairApprove: (pairingId: string) =>
    post<MobilePairingSummary>(`/e2ee/pair/session/${encodeURIComponent(pairingId)}/approve`, {}),
  remoteE2eePairReject: (pairingId: string) =>
    post<{ ok: true }>(`/e2ee/pair/session/${encodeURIComponent(pairingId)}/reject`, {}),
  remoteE2eeDevices: () => get<{ devices: MobilePairingSummary[] }>('/e2ee/devices'),
  remoteE2eeRevokeDevice: (id: number) => del<{ ok: true }>(`/e2ee/devices/${id}`),

  // --- Diff Preview (HTTP) — shared across all gateway providers ---
  diffPreviewGetConfig: () =>
    get<{ workerUrl: string; workerApiKey: string }>('/diff-preview'),
  diffPreviewSaveConfig: (config: { workerUrl?: string; workerApiKey?: string }) =>
    put<{ success: boolean; workerUrl: string; workerApiKey: string }>('/diff-preview', config),

  // --- Commit Message Generation (HTTP) — provider/model used to auto-write commit messages ---
  commitMessageGetConfig: () =>
    get<{ providerId: string; modelId: string }>('/commit-message'),
  commitMessageSaveConfig: (config: { providerId?: string; modelId?: string }) =>
    put<{ success: boolean; providerId: string; modelId: string }>('/commit-message', config),

  // --- Integrations: Linear ---
  integrationLinearGet: () =>
    get<{ configured: boolean; apiKey: string; workspaceName: string }>('/integrations/linear'),
  integrationLinearSave: (apiKey: string) =>
    put<{ configured: boolean; apiKey: string; workspaceName: string }>('/integrations/linear', { apiKey }),
  integrationLinearDelete: () =>
    del<{ success: boolean }>('/integrations/linear'),
  integrationLinearTeams: () =>
    get<{
      teams: Array<{
        id: string
        name: string
        key: string
        projects: Array<{ id: string; name: string }>
        labels: Array<{ id: string; name: string; color: string }>
      }>
    }>('/integrations/linear/teams'),
  integrationLinearTeamDetails: (teamId: string) =>
    get<{
      projects: Array<{ id: string; name: string }>
      labels: Array<{ id: string; name: string; color: string }>
    }>(`/integrations/linear/teams/${encodeURIComponent(teamId)}`),
  integrationLinearCreateIssue: (input: {
    teamId: string
    title: string
    description?: string
    projectId?: string
    priority?: number
    labelIds?: string[]
  }) =>
    post<{ issue: { id: string; identifier: string; url: string; title: string } }>(
      '/integrations/linear/issues',
      input,
    ),

  // --- Integrations: GitHub ---
  integrationGithubGet: () =>
    get<{ configured: boolean; token: string; login: string }>('/integrations/github'),
  integrationGithubSave: (token: string) =>
    put<{ configured: boolean; token: string; login: string }>('/integrations/github', { token }),
  integrationGithubDelete: () =>
    del<{ success: boolean }>('/integrations/github'),
  integrationGithubRepoStatus: (repoPath: string) =>
    post<{
      isRepo: boolean
      remoteName: string | null
      owner: string | null
      repo: string | null
      currentBranch: string | null
      defaultBranch: string | null
      ahead: number
      behind: number
      stagedCount: number
      unstagedCount: number
      untrackedCount: number
      changedFiles: string[]
    }>('/integrations/github/repo-status', { repoPath }),
  integrationGithubCreatePR: (input: {
    repoPath: string
    title: string
    body?: string
    branchName: string
    baseBranch: string
    commitMessage?: string
    draft?: boolean
    remote?: string
  }) =>
    post<{ pr: { number: number; url: string; title: string } }>(
      '/integrations/github/create-pr',
      input,
    ),

  // --- MCP Servers (HTTP) ---
  mcpGetServers: () =>
    get<{ servers: Record<string, McpServerEntry> }>('/mcp/servers'),
  mcpSaveServers: (servers: Record<string, McpServerEntry>) =>
    put<{ servers: Record<string, McpServerEntry> }>('/mcp/servers', { servers }),

  // --- Extensions (file extensions on the operon harness; session-independent) ---
  extensionsList: () =>
    softGet<{ extensions?: OperonExtensionDTO[]; error?: string }>('/extensions/list'),
  extensionsLoad: (id: string) =>
    softPost<{ ok?: true; error?: string }>('/extensions/load', { id }),
  extensionsReload: (id: string) =>
    softPost<{ ok?: true; error?: string }>('/extensions/reload', { id }),
  extensionsUnload: (id: string) =>
    softPost<{ ok?: true; error?: string }>('/extensions/unload', { id }),
  extensionsRemove: (id: string) =>
    softPost<{ ok?: true; error?: string }>('/extensions/remove', { id }),
  extensionsInstall: (input: { url?: string; zipBase64?: string; sha256?: string }) =>
    softPost<{ extension?: OperonExtensionDTO; error?: string }>('/extensions/install', input),
  extensionsMarketplace: () =>
    softGet<ExtensionMarketplaceDTO & { error?: string }>('/extensions/marketplace'),
  extensionsMarketplaceInstall: (id: string) =>
    softPost<{ extension?: OperonExtensionDTO; error?: string }>('/extensions/marketplace/install', { id }),

  // --- Teams / peers (host API consumed by the marketplace-installed Teams extension) ---
  peersRoster: () =>
    softGet<PeersRosterDTO & { error?: string }>('/peers/roster'),
  peersConfig: () =>
    softGet<{ config?: PeersConfig; error?: string }>('/peers/config'),
  peersConfigSave: (config: PeersConfig) =>
    softPost<{ config?: PeersConfig; error?: string }>('/peers/config', { config }),
  peersDisband: (label: string) =>
    softPost<{ members?: number; error?: string }>('/peers/disband', { label }),

  // --- Plugins (session-independent management; global PluginManager) ---
  pluginsList: () =>
    softGet<{ plugins: OperonPluginDTO[]; error?: string }>('/plugins/list'),
  pluginsInfo: (id: string) =>
    softGet<{ info?: OperonPluginInfoDTO; error?: string }>(`/plugins/info?id=${encodeURIComponent(id)}`),
  pluginsMcpAuthStatus: (id: string) =>
    softGet<{ servers?: OperonMcpAuthServerDTO[]; error?: string }>(`/plugins/mcp-auth/status?id=${encodeURIComponent(id)}`),
  pluginsMcpAuthBegin: (id: string, server: string) =>
    softPost<{ authorizationUrl?: string; alreadyAuthorized?: boolean; error?: string }>('/plugins/mcp-auth/begin', { id, server }),
  pluginsMcpAuthCancel: (id: string, server: string) =>
    softPost<{ ok?: true; error?: string }>('/plugins/mcp-auth/cancel', { id, server }),
  pluginsMcpAuthDisconnect: (id: string, server: string) =>
    softPost<{ ok?: true; error?: string }>('/plugins/mcp-auth/disconnect', { id, server }),
  pluginsMcpTools: (id: string, server: string) =>
    softGet<{ tools?: OperonMcpToolDTO[]; error?: string }>(`/plugins/mcp-tools?id=${encodeURIComponent(id)}&server=${encodeURIComponent(server)}`),
  pluginsSkill: (id: string, skill: string) =>
    softGet<{ content?: string; error?: string }>(`/plugins/skill?id=${encodeURIComponent(id)}&skill=${encodeURIComponent(skill)}`),
  pluginsInstall: (source: string) =>
    softPost<{ plugin?: OperonPluginDTO; error?: string }>('/plugins/install', { source }),
  pluginsSetEnabled: (id: string, enabled: boolean) =>
    softPost<{ ok?: true; error?: string }>('/plugins/set-enabled', { id, enabled }),
  pluginsSetMcpEnabled: (id: string, server: string, enabled: boolean) =>
    softPost<{ ok?: true; error?: string }>('/plugins/set-mcp-enabled', { id, server, enabled }),
  pluginsRemove: (id: string) =>
    softPost<{ ok?: true; error?: string }>('/plugins/remove', { id }),
  pluginsReload: () =>
    softPost<{ ok?: true; error?: string }>('/plugins/reload', {}),
  pluginsMarketplace: (source?: string) =>
    softPost<MarketplaceBrowseResult & { error?: string }>('/plugins/marketplace', source ? { source } : {}),
  pluginsMarketplaceDetails: (sources: string[]) =>
    softPost<{ details: Record<string, OperonMarketplaceDetailsDTO>; error?: string }>('/plugins/marketplace/details', { sources }),
  pluginsMarketplaceInfo: (source: string) =>
    softPost<{ info?: OperonMarketplaceInfoDTO | null; error?: string }>('/plugins/marketplace/info', { source }),
  pluginsMarketplaceSkill: (source: string, skill: string) =>
    softGet<{ content?: string; error?: string }>(`/plugins/marketplace/skill?source=${encodeURIComponent(source)}&skill=${encodeURIComponent(skill)}`),
  // Consumed as an <img src>, which cannot carry headers — token rides the query.
  pluginAssetUrl: async (path: string) =>
    withApiTokenQuery(`${await getBaseUrl()}/plugins/asset?path=${encodeURIComponent(path)}`),

  // --- Channel / IM ---
  agentList: httpClient.agentList,
  agentCreate: httpClient.agentCreate,
  agentGet: httpClient.agentGet,
  agentUpdate: httpClient.agentUpdate,
  agentDelete: httpClient.agentDelete,
  channelList: httpClient.channelList,
  channelCreate: httpClient.channelCreate,
  channelDelete: httpClient.channelDelete,
  channelMemberList: httpClient.channelMemberList,
  channelMemberAdd: httpClient.channelMemberAdd,
  channelMemberRemove: httpClient.channelMemberRemove,
  channelMessageList: httpClient.channelMessageList,
  channelMessageCreate: httpClient.channelMessageCreate,
  channelThreadReplies: httpClient.channelThreadReplies,
  channelThreadReply: httpClient.channelThreadReply,
  channelAgentSessions: httpClient.channelAgentSessions,
  channelStreamUrl: httpClient.channelStreamUrl,
  // Project-level tasks ("local Linear")
  taskList: httpClient.taskList,
  taskGet: httpClient.taskGet,
  taskCreate: httpClient.taskCreate,
  taskUpdate: httpClient.taskUpdate,
  taskGetByWorkspace: httpClient.taskGetByWorkspace,
  taskSetArchived: httpClient.taskSetArchived,
  taskComment: httpClient.taskComment,
  taskDispatch: httpClient.taskDispatch,
  taskPrepare: httpClient.taskPrepare,
  taskVerify: httpClient.taskVerify,
  taskStreamUrl: httpClient.taskStreamUrl,

  // --- Notification inbox ---
  inboxList: httpClient.inboxList,
  inboxCounts: httpClient.inboxCounts,
  inboxMarkRead: httpClient.inboxMarkRead,
  inboxArchive: httpClient.inboxArchive,
  inboxStreamUrl: httpClient.inboxStreamUrl,
  // --- Spec-Driven Development (SDD) ---
  sddArtifacts: (taskId: number) =>
    softGet<{ artifacts?: TaskArtifact[]; error?: string }>(`/sdd/tasks/${taskId}/artifacts`),
  sddWriteArtifact: (taskId: number, kind: ArtifactKind, content: string) =>
    softPost<{ artifact?: TaskArtifact; error?: string }>(`/sdd/tasks/${taskId}/artifacts/${kind}`, {
      content,
    }),
  sddMergeSubtask: (taskId: number) =>
    softPost<{ result?: { parentTaskNumber: number; mergedBranch: string }; error?: string }>(
      `/sdd/tasks/${taskId}/merge`,
      {},
    ),
  sddSediment: (taskId: number, apply: boolean) =>
    softPost<{
      result?: {
        capability: string
        applied: boolean
        conflicts: Array<{ kind: string; id: string; detail: string }>
        preview: string
      }
      error?: string
    }>(`/sdd/tasks/${taskId}/sediment`, { apply }),
  taskLabelList: httpClient.taskLabelList,
  taskLabelCreate: httpClient.taskLabelCreate,
  taskTeamList: httpClient.taskTeamList,
  taskTeamCreate: httpClient.taskTeamCreate,
  taskTeamUpdate: httpClient.taskTeamUpdate,
  taskTeamDelete: httpClient.taskTeamDelete,
  agentStop: httpClient.agentStop,
  agentReset: httpClient.agentReset,
  agentListSessions: httpClient.agentListSessions,
  bindingReset: httpClient.bindingReset,
}
