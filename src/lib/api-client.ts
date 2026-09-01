import type { UIMessage } from 'ai'
import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  Channel,
  CreateChannelInput,
  ChannelMember,
  ChannelMessage,
  CreateMessageInput,
  AgentSession,
  AgentBinding,
} from '../types/channel.js'
import { getUserId, getSelectedNodeId } from './web-auth.js'
import type { Notification, UnreadCounts } from '@/types/notification'
import type {
  Task,
  TaskListItem,
  TaskDetail,
  TaskLabel,
  TaskActivity,
  Team,
  CreateTeamInput,
  UpdateTeamInput,
  CreateTaskInput as CreateProjectTaskInput,
  UpdateTaskInput as UpdateProjectTaskInput,
  CreateTaskLabelInput,
  TaskStatus,
  TaskPriority,
  PreparedSubtask,
} from '../types/task.js'

let _baseUrl: string | null = null
let _apiToken: string | null = null

export async function getBaseUrl(): Promise<string> {
  if (__APP_TARGET__ === 'web') {
    // Web client: every request goes to the cloud broker, which tunnels it to the
    // selected node's local backend. userId comes from the login token, nodeId from
    // the picker. Not cached — the user can switch nodes at runtime.
    const broker = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')
    const userId = getUserId()
    const nodeId = getSelectedNodeId()
    if (!userId || !nodeId) throw new Error('web client not authenticated / no node selected')
    return `${broker}/u/${userId}/n/${nodeId}/api`
  }

  if (_baseUrl) return _baseUrl

  if (typeof window !== 'undefined' && window.electronAPI?.getServerPort) {
    const port = await window.electronAPI.getServerPort()
    // Fetch the startup token in the same bootstrap step so every code path
    // that ran `await getBaseUrl()` may use the sync accessors below.
    _apiToken = (await window.electronAPI.getServerToken?.()) ?? null
    _baseUrl = `http://127.0.0.1:${port}/api`
  } else {
    // Standalone browser mode - use default or env-provided port. The token has
    // no IPC channel here; inject it manually (copy from ~/.operon/run/api-token)
    // or run the server with OPERON_DISABLE_API_TOKEN=1.
    const port = (window as any).__OPERON_SERVER_PORT__ || 3100
    _apiToken = (window as any).__OPERON_SERVER_TOKEN__ ?? null
    _baseUrl = `http://127.0.0.1:${port}/api`
  }

  return _baseUrl
}

/**
 * Auth headers for direct (loopback) requests to the local server. Empty on the
 * web target: broker-tunneled traffic gets the token stamped on by the tunnel
 * agent on the desktop side, never by this client. Valid after the first
 * `getBaseUrl()` resolves — same lifecycle as `getBaseUrlSync()`.
 */
export function apiAuthHeaders(): Record<string, string> {
  if (__APP_TARGET__ === 'web' || !_apiToken) return {}
  return { 'x-operon-token': _apiToken }
}

/**
 * The startup token itself, for carriers that need it raw (WebSocket URL
 * params). Null on web (broker path), before the first `getBaseUrl()`, and
 * when auth is disabled.
 */
export function getApiTokenSync(): string | null {
  return __APP_TARGET__ === 'web' ? null : _apiToken
}

/**
 * Append the token as a query param, for requests whose carrier cannot set
 * headers: `<img src>` attachment loads and WebSocket upgrades. No-op on web
 * (broker path) and when auth is disabled.
 */
export function withApiTokenQuery(url: string): string {
  if (__APP_TARGET__ === 'web' || !_apiToken) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(_apiToken)}`
}

/**
 * Base URL without awaiting, or null when it isn't known yet.
 *
 * Only the desktop path can miss: it learns the port over IPC once and caches
 * it, so this returns null solely before the first `getBaseUrl()` of the
 * session. Callers that must render synchronously (an `<img src>`) should treat
 * null as "not ready" and retry after awaiting `getBaseUrl()`.
 */
export function getBaseUrlSync(): string | null {
  if (__APP_TARGET__ === 'web') {
    const broker = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')
    const userId = getUserId()
    const nodeId = getSelectedNodeId()
    if (!userId || !nodeId) return null
    return `${broker}/u/${userId}/n/${nodeId}/api`
  }
  return _baseUrl
}

/**
 * The one place a request's HTTP status is turned into either a value or a
 * throw. Exported because `api.ts` used to carry its own fetch helpers that
 * skipped the `res.ok` check entirely — a 500 came back as `{ error }` typed as
 * the success shape, so the failure only surfaced a few renders later as
 * `Cannot read properties of undefined`.
 *
 * The fallback carries the status because the bodies that lose it are exactly
 * the ones with nothing else to say: Hono's default 404 is the plain text
 * "404 Not Found", and a 502 from the remote tunnel is HTML. Both fail
 * `res.json()`, land on `null`, and would otherwise read as a bare
 * "Request failed".
 */
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
      ...(options?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const err = asRecord(await res.json().catch(() => null))
    throw new Error(errorMessage(err, `${res.status} ${res.statusText}`))
  }
  return res.json() as Promise<T>
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function errorMessage(body: Record<string, unknown> | null, fallback?: string): string {
  return (
    stringValue(body?.message) ??
    stringValue(body?.error) ??
    stringValue(body?.reason) ??
    gateBlockMessage(body) ??
    (fallback?.trim() ? fallback : undefined) ??
    'Request failed'
  )
}

function gateBlockMessage(body: Record<string, unknown> | null): string | undefined {
  if (!body || body.blocked !== true) return undefined
  const gate = stringValue(body.gate)
  const next = stringValue(body.next)
  if (gate && next) return `SDD gate blocked (${gate}): ${next}`
  if (next) return next

  const reasons = Array.isArray(body.reasons)
    ? body.reasons
        .map(asRecord)
        .map((reason) => stringValue(reason?.hint))
        .filter((hint): hint is string => Boolean(hint))
    : []
  if (reasons.length === 0) return gate ? `SDD gate blocked (${gate})` : undefined
  return gate
    ? `SDD gate blocked (${gate}): ${reasons.join('; ')}`
    : reasons.join('; ')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

// --- Git ---

export function gitStatus(repoPath: string) {
  return post<{
    current: string | null
    ahead: number
    behind: number
    files: { path: string; status: string; index: string; workingDir: string }[]
    staged: { path: string; status: string; index: string; workingDir: string }[]
    unstaged: { path: string; status: string; index: string; workingDir: string }[]
    untracked: { path: string; status: string; index: string; workingDir: string }[]
  }>('/git/status', { repoPath })
}

export async function gitDiff(repoPath: string, file?: string, cached?: boolean): Promise<string> {
  const res = await post<{ diff: string }>('/git/diff', { repoPath, file, cached })
  return res.diff
}

export async function gitShow(repoPath: string, ref: string, file: string): Promise<string> {
  const res = await post<{ content: string }>('/git/show', { repoPath, ref, file })
  return res.content
}

export function gitStage(repoPath: string, filePath: string) {
  return post<{ success: boolean }>('/git/stage', { repoPath, filePath }).then(() => true)
}

export function gitStageAll(repoPath: string) {
  return post<{ success: boolean }>('/git/stage-all', { repoPath }).then(() => true)
}

export function gitUnstage(repoPath: string, filePath: string) {
  return post<{ success: boolean }>('/git/unstage', { repoPath, filePath }).then(() => true)
}

export function gitUnstageAll(repoPath: string) {
  return post<{ success: boolean }>('/git/unstage-all', { repoPath }).then(() => true)
}

export function gitListRemotes(repoPath: string) {
  return post<{ name: string; url: string }[]>('/git/remotes', { repoPath })
}

export function gitCommit(repoPath: string, message: string, includeUnstaged?: boolean) {
  return post<{ success: boolean; commit: string }>('/git/commit', {
    repoPath,
    message,
    includeUnstaged,
  })
}

export function gitGenerateCommitMessage(repoPath: string): Promise<string> {
  return post<{ message: string }>('/git/generate-commit-message', { repoPath }).then((r) => r.message)
}

export type PushErrorCode =
  | 'no-remote'
  | 'no-upstream'
  | 'rejected'
  | 'remote-changed'
  | 'auth'
  | 'unknown'

export function gitPushStatus(repoPath: string) {
  return post<{
    branch: string | null
    upstream: string | null
    ahead: number
    behind: number
    hasRemote: boolean
    remote: string | null
  }>('/git/push-status', { repoPath })
}

export function gitPush(repoPath: string, options?: { setUpstream?: boolean; force?: boolean }) {
  return post<{ success: boolean; code: PushErrorCode | null; error: string | null }>('/git/push', {
    repoPath,
    setUpstream: options?.setUpstream,
    force: options?.force,
  })
}

export function gitWorktreeList(repoPath: string) {
  return post<{ path: string; branch: string | null; head: string | null; detached: boolean }[]>(
    '/git/worktree/list',
    { repoPath }
  )
}

export function gitWorktreeAdd(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  createBranch = true,
  source?: string,
  // When provided, the server derives the worktree path from operon's managed
  // worktrees dir (~/.operon/worktrees/<id>-<repo>/<name>) and `worktreePath` is
  // ignored. The resolved absolute path is returned.
  managed?: { projectId: number; name: string }
) {
  return post<{ success: boolean; path: string }>('/git/worktree/add', {
    repoPath,
    path: worktreePath,
    branch: branchName,
    createBranch,
    source,
    projectId: managed?.projectId,
    name: managed?.name,
  }).then((r) => r.path)
}

export function gitWorktreeRemove(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean } = {}
) {
  return post<{ success: boolean }>('/git/worktree/remove', {
    repoPath,
    path: worktreePath,
    force: options.force,
  }).then(
    () => true
  )
}

export type DiffStatEntry = { additions: number; deletions: number }
export type DiffStatResult = { staged: Record<string, DiffStatEntry>; unstaged: Record<string, DiffStatEntry> }

export function gitDiffStat(repoPath: string) {
  return post<DiffStatResult>('/git/diff-stat', { repoPath })
}

export function gitStatusWithDiffStat(repoPath: string) {
  return post<{
    status: {
      current: string | null
      ahead: number
      behind: number
      files: { path: string; status: string; index: string; workingDir: string }[]
      staged: { path: string; status: string; index: string; workingDir: string }[]
      unstaged: { path: string; status: string; index: string; workingDir: string }[]
      untracked: { path: string; status: string; index: string; workingDir: string }[]
    }
    diffStat: DiffStatResult
  }>('/git/status-with-diff-stat', { repoPath })
}

export interface GitBranchEntry {
  name: string
  current: boolean
  remote: boolean
}

export function gitBranches(repoPath: string) {
  return post<{ branches: GitBranchEntry[] }>('/git/branches', { repoPath }).then((r) => r.branches)
}

export interface GitCommitEntry {
  sha: string
  shortSha: string
  subject: string
  relativeTime: string
  authorName: string
}

export function gitCommits(repoPath: string, limit?: number) {
  return post<{ commits: GitCommitEntry[] }>('/git/commits', { repoPath, limit }).then((r) => r.commits)
}

export function gitDefaultBaseBranch(repoPath: string) {
  return post<{ base: string | null }>('/git/default-base-branch', { repoPath }).then((r) => r.base)
}

export function gitMergeBase(repoPath: string, ref: string) {
  return post<{ mergeBase: string | null }>('/git/merge-base', { repoPath, ref }).then((r) => r.mergeBase)
}

export function gitCommitParent(repoPath: string, sha: string) {
  return post<{ parent: string }>('/git/commit-parent', { repoPath, sha }).then((r) => r.parent)
}

export function gitDiffRange(repoPath: string, baseRef: string, headRef?: string | null) {
  return post<{
    files: { path: string; status: string; additions: number; deletions: number }[]
  }>('/git/diff-range', {
    repoPath,
    baseRef,
    headRef,
  }).then((r) => r.files)
}

export function gitFileDiffRange(
  repoPath: string,
  file: string | undefined,
  baseRef: string,
  headRef?: string | null
) {
  return post<{ diff: string }>('/git/file-diff-range', {
    repoPath,
    file,
    baseRef,
    headRef,
  }).then((r) => r.diff)
}

export function gitRestore(repoPath: string, filePath: string) {
  return post<{ success: boolean }>('/git/restore', { repoPath, filePath }).then(() => true)
}

export function gitRestoreAll(repoPath: string) {
  return post<{ success: boolean }>('/git/restore-all', { repoPath }).then(() => true)
}

// --- File System ---

export function readDir(dirPath: string) {
  return post<{ name: string; path: string; isDirectory: boolean }[]>('/fs/read-dir', {
    path: dirPath,
  })
}

export function findPaths(rootPath: string, query: string, limit = 50) {
  return post<{ name: string; path: string; isDirectory: boolean }[]>('/fs/find-paths', {
    rootPath,
    query,
    limit,
  })
}

export async function readFile(filePath: string): Promise<string> {
  const res = await post<{ content: string }>('/fs/read-file', { path: filePath })
  return res.content
}

export async function getFileUrl(filePath: string): Promise<string> {
  const baseUrl = await getBaseUrl()
  return `${baseUrl}/fs/file?path=${encodeURIComponent(filePath)}`
}

export function writeFile(filePath: string, content: string) {
  return post<{ success: boolean }>('/fs/write-file', { path: filePath, content }).then(
    () => undefined as void
  )
}

export async function saveTempFile(content: string, extension?: string): Promise<string> {
  const res = await post<{ path: string }>('/fs/save-temp-file', { content, extension })
  return res.path
}

export async function exists(targetPath: string): Promise<boolean> {
  const res = await post<{ exists: boolean }>('/fs/exists', { path: targetPath })
  return res.exists
}

export async function getHomePath(): Promise<string> {
  const res = await request<{ path: string }>('/fs/home-path')
  return res.path
}

export function stat(targetPath: string) {
  return post<{ isDirectory: boolean; isFile: boolean; size: number; mtime: string }>('/fs/stat', {
    path: targetPath,
  })
}

// --- Chat History ---

export function chatHistoryGet(chatId: number, opts?: { before?: number; limit?: number }) {
  const params = new URLSearchParams()
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts?.before !== undefined) params.set('before', String(opts.before))
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<{ messages: UIMessage[]; model?: string; providerId?: string; thinkingLevel?: string; revision: number; total?: number; hasMore?: boolean; nextCursor?: number; updatedAt?: number }>(
    `/chat-history/${chatId}${qs}`
  )
}

export function chatHistoryCreate(input: {
  baseRevision: number
  replaceFrom: number
  tailMessages: UIMessage[]
  tp?: string
  workspaceId?: number
  model?: string
  providerId?: string
}) {
  return request<
    | { success: true; chatId: number; revision: number }
    | { success: false; conflict: true; revision: number }
  >('/chat-history', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function chatHistoryPatch(
  chatId: number,
  input: {
    baseRevision: number
    replaceFrom: number
    tailMessages: UIMessage[]
    workspaceId?: number
    model?: string
    providerId?: string
  }
) {
  return request<
    | { success: true; chatId: number; revision: number }
    | { success: false; conflict: true; revision: number }
  >(`/chat-history/${chatId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function chatHistoryClear(chatId: number) {
  return request<{ success: boolean }>(`/chat-history/${chatId}`, {
    method: 'DELETE',
  }).then((r) => r.success)
}

/**
 * Create the (empty) chat row backing a side chat branched off `parentChatId`.
 * The provider session is forked server-side on the first turn, not here.
 */
export function chatHistorySideCreate(parentChatId: number, title?: string) {
  return request<{ success: boolean; chatId?: number; error?: string }>('/chat-history/side', {
    method: 'POST',
    body: JSON.stringify({ parentChatId, ...(title ? { title } : {}) }),
  })
}

export function chatHistoryList(
  workspaceId?: number,
  tp?: string,
  paging?: { limit?: number; offset?: number },
) {
  const searchParams = new URLSearchParams()
  if (workspaceId !== undefined) searchParams.set('workspaceId', String(workspaceId))
  if (tp) searchParams.set('tp', tp)
  if (paging?.limit !== undefined) searchParams.set('limit', String(paging.limit))
  if (paging?.offset) searchParams.set('offset', String(paging.offset))
  const params = searchParams.toString() ? `?${searchParams.toString()}` : ''
  return request<{ id: number; tp: string; title: string; updatedAt: number; model?: string; providerId?: string; metadata?: { workflowId?: number; runId?: number; nodeId?: string; nodeName?: string; cronjobId?: number } }[]>(
    `/chat-history${params}`
  )
}

// --- AI turn control ---

/**
 * End the turn running on this chat. The node keeps a turn alive when its
 * originating request drops — other surfaces may be attached to the same live
 * stream — so a deliberate Stop has to be signalled out-of-band like this.
 */
export function aiAbort(chatId: number) {
  return post<{ success: boolean }>('/ai/abort', { chatId })
}

// --- Channel / IM ---

export function agentList() {
  return request<{ agents: Agent[] }>('/agents')
}

export function agentCreate(input: CreateAgentInput) {
  return request<{ agent: Agent }>('/agents', { method: 'POST', body: JSON.stringify(input) })
}

export function agentGet(id: number) {
  return request<{ agent: Agent }>(`/agents/${id}`)
}

export function agentUpdate(id: number, updates: UpdateAgentInput) {
  return request<{ agent: Agent }>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(updates) })
}

export function agentDelete(id: number) {
  return request<{ success: boolean }>(`/agents/${id}`, { method: 'DELETE' })
}

export function channelList(projectId: number) {
  return request<{ channels: Channel[] }>(`/channels?projectId=${projectId}`)
}

export function channelCreate(input: CreateChannelInput) {
  return request<{ channel: Channel }>('/channels', { method: 'POST', body: JSON.stringify(input) })
}

export function channelDelete(id: number) {
  return request<{ success: boolean }>(`/channels/${id}`, { method: 'DELETE' })
}

export function channelMemberList(channelId: number) {
  return request<{ members: ChannelMember[] }>(`/channels/${channelId}/members`)
}

export function channelMemberAdd(channelId: number, agentId: number) {
  return request<{ member: ChannelMember }>(`/channels/${channelId}/members`, {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  })
}

export function channelMemberRemove(channelId: number, agentId: number) {
  return request<{ success: boolean }>(`/channels/${channelId}/members/${agentId}`, { method: 'DELETE' })
}

export function channelMessageList(channelId: number, opts?: { before?: number; limit?: number }) {
  const params = new URLSearchParams()
  if (opts?.before !== undefined) params.set('before', String(opts.before))
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<{ messages: ChannelMessage[]; hasMore: boolean }>(`/channels/${channelId}/messages${qs}`)
}

export function channelMessageCreate(channelId: number, body: Omit<CreateMessageInput, 'channelId'>) {
  return request<{ message: ChannelMessage }>(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function channelThreadReplies(channelId: number, messageId: number) {
  return request<{ replies: ChannelMessage[] }>(`/channels/${channelId}/messages/${messageId}/replies`)
}

export function channelThreadReply(channelId: number, messageId: number, body: Omit<CreateMessageInput, 'channelId' | 'threadRootId'>) {
  return request<{ message: ChannelMessage }>(`/channels/${channelId}/messages/${messageId}/replies`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function channelAgentSessions(projectId: number) {
  return request<{ sessions: AgentSession[] }>(`/channels/agents/sessions?projectId=${projectId}`)
}

export async function channelStreamUrl(channelId: number): Promise<string> {
  const baseUrl = await getBaseUrl()
  return `${baseUrl}/channels/${channelId}/stream`
}

// ---- Project-level tasks ("local Linear") ----

export interface TaskListFilter {
  status?: TaskStatus
  assignedAgentId?: number
  labelId?: number
  priority?: TaskPriority
  /** Include archived tasks (default false). */
  includeArchived?: boolean
}

export function taskList(projectId: number, filter: TaskListFilter = {}) {
  const params = new URLSearchParams({ projectId: String(projectId) })
  if (filter.status) params.set('status', filter.status)
  if (filter.assignedAgentId != null) params.set('assignee', String(filter.assignedAgentId))
  if (filter.labelId != null) params.set('label', String(filter.labelId))
  if (filter.priority != null) params.set('priority', String(filter.priority))
  if (filter.includeArchived) params.set('includeArchived', '1')
  return request<{ tasks: TaskListItem[] }>(`/tasks?${params.toString()}`)
}

export function taskSetArchived(taskId: number, archived: boolean) {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}/archive`, {
    method: 'POST',
    body: JSON.stringify({ archived }),
  })
}

export function taskGet(taskId: number) {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}`)
}

/** The task that owns a dispatched worktree, or null for a plain workspace. */
export function taskGetByWorkspace(workspaceId: number) {
  return request<{ task: Task | null }>(`/tasks/by-workspace/${workspaceId}`)
}

export function taskCreate(input: CreateProjectTaskInput) {
  return request<{ task: TaskDetail }>(`/tasks`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function taskUpdate(taskId: number, updates: UpdateProjectTaskInput & { actorName?: string }) {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
}

export function taskComment(taskId: number, body: string, actorName?: string) {
  return request<{ activity: TaskActivity }>(`/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, actorName }),
  })
}

export async function taskStreamUrl(projectId: number): Promise<string> {
  const baseUrl = await getBaseUrl()
  return `${baseUrl}/tasks/stream?projectId=${projectId}`
}

// ---- Notification inbox ----

export interface InboxListFilter {
  severity?: 'action' | 'info'
  unreadOnly?: boolean
  cursor?: number
  limit?: number
}

export interface InboxListPage {
  notifications: Notification[]
  hasMore: boolean
  nextCursor?: number
}

export function inboxList(filter: InboxListFilter = {}) {
  const params = new URLSearchParams()
  if (filter.severity) params.set('severity', filter.severity)
  if (filter.unreadOnly) params.set('unreadOnly', '1')
  if (filter.cursor != null) params.set('cursor', String(filter.cursor))
  if (filter.limit != null) params.set('limit', String(filter.limit))
  const qs = params.toString()
  return request<InboxListPage>(`/inbox${qs ? `?${qs}` : ''}`)
}

export function inboxCounts() {
  return request<UnreadCounts>('/inbox/counts')
}

export function inboxMarkRead(payload: { ids?: number[]; sourceKeys?: string[]; all?: boolean }) {
  return request<{ ids: number[] }>('/inbox/read', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function inboxArchive(payload: { ids?: number[]; all?: boolean }) {
  return request<{ ids: number[] }>('/inbox/archive', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function inboxStreamUrl(): Promise<string> {
  const baseUrl = await getBaseUrl()
  return `${baseUrl}/inbox/stream`
}

export function taskDispatch(
  taskId: number,
  assignedAgentId: number,
  subtaskAgents?: Record<number, number>,
) {
  return request<{ task: TaskDetail }>(`/tasks/${taskId}/dispatch`, {
    method: 'POST',
    body: JSON.stringify({ assignedAgentId, subtaskAgents }),
  })
}

/**
 * Prepare an SDD parent for dispatch: server auto-signs spec/plan + decomposes,
 * and returns the resulting subtasks so the UI can assign an agent to each. An
 * empty list means a tiny single-task change — just taskDispatch it directly.
 */
export function taskPrepare(taskId: number) {
  return request<{ subtasks: PreparedSubtask[]; error?: string }>(`/tasks/${taskId}/prepare`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/**
 * Run an independent verifier over a change that is in review. Opt-in — skipping
 * it and marking Done straight away is a supported path (the sign-off then records
 * that nothing was verified). 409 carries the reason as `{ error }`.
 */
export function taskVerify(taskId: number, agentId: number) {
  return request<{ task: TaskDetail; error?: string }>(`/tasks/${taskId}/verify`, {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  })
}

export function taskLabelList(projectId: number) {
  return request<{ labels: TaskLabel[] }>(`/tasks/labels?projectId=${projectId}`)
}

export function taskTeamList(projectId: number) {
  return request<{ teams: Team[] }>(`/tasks/teams?projectId=${projectId}`)
}

export function taskTeamCreate(input: CreateTeamInput) {
  return request<{ team: Team }>(`/tasks/teams`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function taskTeamUpdate(teamId: number, input: UpdateTeamInput) {
  return request<{ team: Team }>(`/tasks/teams/${teamId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function taskTeamDelete(teamId: number) {
  return request<{ success: boolean }>(`/tasks/teams/${teamId}`, { method: 'DELETE' })
}

export function taskLabelCreate(input: CreateTaskLabelInput) {
  return request<{ label: TaskLabel }>(`/tasks/labels`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function agentStop(agentId: number, projectId: number) {
  return request<{ success: boolean }>(`/agents/${agentId}/stop?projectId=${projectId}`, { method: 'POST', body: '{}' })
}

export function agentReset(agentId: number, projectId: number) {
  return request<{ success: boolean }>(`/agents/${agentId}/reset?projectId=${projectId}`, { method: 'POST', body: '{}' })
}

export function agentListSessions(agentId: number) {
  return request<{ sessions: AgentBinding[] }>(`/agents/${agentId}/sessions`)
}

export function bindingReset(bindingId: number) {
  return request<{ success: boolean }>(`/agent-bindings/${bindingId}/reset`, { method: 'POST', body: '{}' })
}
