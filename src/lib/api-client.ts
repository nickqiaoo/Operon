import type { UIMessage } from 'ai'
import type { SshEnvironmentRef } from '@shared/ssh-environment'
import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  Channel,
  CreateChannelInput,
  ChannelMember,
  ChannelMessage,
  ChannelThread,
  ChannelUnread,
  ThreadRootActivity,
  WaitingSession,
  CreateMessageInput,
  AgentSession,
  AgentBinding,
} from '../types/channel.js'
import { getUserId, getSelectedNodeId } from './web-auth.js'
import type { Notification, UnreadCounts } from '@/types/notification'
import type { SpecRole, SpecRoleSettings, SpecStage, SpecView } from '@shared/spec'
import type {
  Task,
  TaskListItem,
  TaskDetail,
  TaskLabel,
  TaskActivity,
  TaskAttachment,
  TaskWorkspaceMode,
  CreateTaskInput as CreateProjectTaskInput,
  UpdateTaskInput as UpdateProjectTaskInput,
  CreateTaskLabelInput,
  TaskStatus,
  TaskPriority,
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
 * Which backend a set of API calls goes to. Every chat tab is bound to one (see
 * `ChatApiContext`): today always this machine's server, later also another
 * machine of the account reached through the local server's relay. Keeping the
 * address behind this interface is what lets one tab talk to a different
 * machine without the rest of the app noticing — never switch the global base
 * URL for that, hidden tabs keep streaming and polling against it.
 */
export interface ApiTransport {
  /** The machine this transport reaches; undefined for this machine's own server. */
  readonly nodeId?: string
  baseUrl(): Promise<string>
  /** Same as `baseUrl()` without awaiting; null when not known yet. */
  baseUrlSync(): string | null
  authHeaders(): Record<string, string>
  /** For carriers that cannot set headers (`<img src>`, WebSocket upgrades). */
  withTokenQuery(url: string): string
}

/** This machine's server — what the global `api` and every local tab use. */
export const localTransport: ApiTransport = {
  baseUrl: getBaseUrl,
  baseUrlSync: getBaseUrlSync,
  authHeaders: apiAuthHeaders,
  withTokenQuery: withApiTokenQuery,
}

const remoteTransports = new Map<string, ApiTransport>()

/**
 * Another machine of the account, reached through this machine's server
 * (`/api/remote/:nodeId/*` relays end-to-end encrypted over the Broker). The
 * renderer still only ever talks to its own server, with its own token: the
 * relay authenticates to the other machine. One instance per machine, so it can
 * serve as a stable React dependency and cache key.
 */
export function remoteTransport(nodeId: string): ApiTransport {
  let transport = remoteTransports.get(nodeId)
  if (!transport) {
    const prefix = `/remote/${encodeURIComponent(nodeId)}`
    transport = {
      nodeId,
      baseUrl: async () => `${await getBaseUrl()}${prefix}`,
      baseUrlSync: () => {
        const base = getBaseUrlSync()
        return base == null ? null : `${base}${prefix}`
      },
      authHeaders: apiAuthHeaders,
      withTokenQuery: withApiTokenQuery,
    }
    remoteTransports.set(nodeId, transport)
  }
  return transport
}

/** The transport for the machine a chat lives on; `undefined` is this machine. */
export function transportFor(nodeId: string | undefined): ApiTransport {
  return nodeId ? remoteTransport(nodeId) : localTransport
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
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
export function request<T>(path: string, options?: RequestInit): Promise<T> {
  return requestVia<T>(localTransport, path, options)
}

/** `request` against a given backend — what `createHttpClient` / `createApi` bind to. */
export async function requestVia<T>(transport: ApiTransport, path: string, options?: RequestInit): Promise<T> {
  const baseUrl = await transport.baseUrl()
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...transport.authHeaders(),
      ...(options?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const err = asRecord(await res.json().catch(() => null))
    throw new ApiError(res.status, errorMessage(err, `${res.status} ${res.statusText}`))
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
    (fallback?.trim() ? fallback : undefined) ??
    'Request failed'
  )
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}


export type PushErrorCode =
  | 'no-remote'
  | 'no-upstream'
  | 'rejected'
  | 'remote-changed'
  | 'auth'
  | 'unknown'


export type DiffStatEntry = { additions: number; deletions: number }

export type DiffStatResult = { staged: Record<string, DiffStatEntry>; unstaged: Record<string, DiffStatEntry> }


export interface GitBranchEntry {
  name: string
  current: boolean
  remote: boolean
}


export interface GitCommitEntry {
  sha: string
  shortSha: string
  subject: string
  relativeTime: string
  authorName: string
}


interface ChatHistoryItem {
  id: number
  tp: string
  title: string
  updatedAt: number
  model?: string
  providerId?: string
  workspaceId?: number | null
  metadata?: { workflowId?: number; runId?: number; nodeId?: string; nodeName?: string; cronjobId?: number }
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

/**
 * The HTTP endpoints, bound to one backend. `api.ts`'s `createApi` builds on
 * this; the named exports at the bottom are the local instance for the few
 * modules that import a function directly.
 */
export function createHttpClient(transport: ApiTransport) {
  // Same names as the module-level helpers, bound to `transport`, so the
  // endpoint bodies below read exactly as they would against the local server.
  function request<T>(path: string, options?: RequestInit): Promise<T> {
    return requestVia<T>(transport, path, options)
  }
  const getBaseUrl = () => transport.baseUrl()
  const withApiTokenQuery = (url: string) => transport.withTokenQuery(url)

  function post<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }


  // --- Git ---

  function gitStatus(repoPath: string) {
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


  async function gitDiff(repoPath: string, file?: string, cached?: boolean): Promise<string> {
    const res = await post<{ diff: string }>('/git/diff', { repoPath, file, cached })
    return res.diff
  }


  async function gitShow(repoPath: string, ref: string, file: string): Promise<string> {
    const res = await post<{ content: string }>('/git/show', { repoPath, ref, file })
    return res.content
  }


  function gitStage(repoPath: string, filePath: string) {
    return post<{ success: boolean }>('/git/stage', { repoPath, filePath }).then(() => true)
  }


  function gitStageAll(repoPath: string) {
    return post<{ success: boolean }>('/git/stage-all', { repoPath }).then(() => true)
  }


  function gitUnstage(repoPath: string, filePath: string) {
    return post<{ success: boolean }>('/git/unstage', { repoPath, filePath }).then(() => true)
  }


  function gitUnstageAll(repoPath: string) {
    return post<{ success: boolean }>('/git/unstage-all', { repoPath }).then(() => true)
  }


  function gitListRemotes(repoPath: string) {
    return post<{ name: string; url: string }[]>('/git/remotes', { repoPath })
  }


  function gitCommit(repoPath: string, message: string, includeUnstaged?: boolean) {
    return post<{ success: boolean; commit: string }>('/git/commit', {
      repoPath,
      message,
      includeUnstaged,
    })
  }


  function gitGenerateCommitMessage(repoPath: string): Promise<string> {
    return post<{ message: string }>('/git/generate-commit-message', { repoPath }).then((r) => r.message)
  }


  function gitGeneratePrSummary(repoPath: string, baseBranch: string, signal?: AbortSignal) {
    // Aborting matters here: the request is a full model turn, and the server
    // cancels it when the client disconnects.
    return request<{ title: string; body: string }>('/git/generate-pr-summary', {
      method: 'POST',
      body: JSON.stringify({ repoPath, baseBranch }),
      signal,
    })
  }


  /** Switch the checkout at `repoPath` to an existing branch; rejects when local changes are in the way. */
  function gitCheckout(repoPath: string, branchName: string) {
    return post<{ success: boolean }>('/git/checkout', { repoPath, branchName })
  }


  function gitCheckoutNewBranch(repoPath: string, branchName: string) {
    return post<{ success: boolean }>('/git/checkout-new-branch', { repoPath, branchName })
  }


  function gitPushStatus(repoPath: string) {
    return post<{
      branch: string | null
      upstream: string | null
      ahead: number
      behind: number
      hasRemote: boolean
      remote: string | null
    }>('/git/push-status', { repoPath })
  }


  function gitPush(repoPath: string, options?: { setUpstream?: boolean; force?: boolean }) {
    return post<{ success: boolean; code: PushErrorCode | null; error: string | null }>('/git/push', {
      repoPath,
      setUpstream: options?.setUpstream,
      force: options?.force,
    })
  }


  function gitWorktreeList(repoPath: string) {
    return post<{ path: string; branch: string | null; head: string | null; detached: boolean }[]>(
      '/git/worktree/list',
      { repoPath }
    )
  }


  function gitWorktreeAdd(
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


  function gitWorktreeRemove(
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


  function gitDiffStat(repoPath: string) {
    return post<DiffStatResult>('/git/diff-stat', { repoPath })
  }


  function gitStatusWithDiffStat(repoPath: string) {
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


  function gitBranches(repoPath: string) {
    return post<{ branches: GitBranchEntry[] }>('/git/branches', { repoPath }).then((r) => r.branches)
  }


  function gitCommits(repoPath: string, limit?: number) {
    return post<{ commits: GitCommitEntry[] }>('/git/commits', { repoPath, limit }).then((r) => r.commits)
  }


  function gitDefaultBaseBranch(repoPath: string) {
    return post<{ base: string | null }>('/git/default-base-branch', { repoPath }).then((r) => r.base)
  }


  function gitMergeBase(repoPath: string, ref: string) {
    return post<{ mergeBase: string | null }>('/git/merge-base', { repoPath, ref }).then((r) => r.mergeBase)
  }


  function gitCommitParent(repoPath: string, sha: string) {
    return post<{ parent: string }>('/git/commit-parent', { repoPath, sha }).then((r) => r.parent)
  }


  function gitDiffRange(repoPath: string, baseRef: string, headRef?: string | null) {
    return post<{
      files: { path: string; status: string; additions: number; deletions: number }[]
    }>('/git/diff-range', {
      repoPath,
      baseRef,
      headRef,
    }).then((r) => r.files)
  }


  function gitFileDiffRange(
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


  function gitRestore(repoPath: string, filePath: string) {
    return post<{ success: boolean }>('/git/restore', { repoPath, filePath }).then(() => true)
  }


  function gitRestoreAll(repoPath: string) {
    return post<{ success: boolean }>('/git/restore-all', { repoPath }).then(() => true)
  }


  // --- File System ---

  function readDir(dirPath: string) {
    return post<{ name: string; path: string; isDirectory: boolean }[]>('/fs/read-dir', {
      path: dirPath,
    })
  }


  /** Fuzzy search over every file in the workspace; paths relative to `rootPath`, best first. */
  function searchFiles(rootPath: string, query: string, limit?: number) {
    return post<{ files: string[] }>('/fs/search-files', { rootPath, query, limit }).then((r) => r.files)
  }


  function findPaths(rootPath: string, query: string, limit = 50) {
    return post<{ name: string; path: string; isDirectory: boolean }[]>('/fs/find-paths', {
      rootPath,
      query,
      limit,
    })
  }


  async function readFile(filePath: string): Promise<string> {
    const res = await post<{ content: string }>('/fs/read-file', { path: filePath })
    return res.content
  }


  /**
   * A URL an `<img>` can load the file from. Desktop carries the API token as a
   * query param, since an image load can't set the header (without it the server
   * answers 401). Web loads go through useAuthedObjectUrl instead.
   */
  async function getFileUrl(filePath: string): Promise<string> {
    const baseUrl = await getBaseUrl()
    return withApiTokenQuery(`${baseUrl}/fs/file?path=${encodeURIComponent(filePath)}`)
  }


  function writeFile(filePath: string, content: string) {
    return post<{ success: boolean }>('/fs/write-file', { path: filePath, content }).then(
      () => undefined as void
    )
  }


  async function saveTempFile(content: string, extension?: string): Promise<string> {
    const res = await post<{ path: string }>('/fs/save-temp-file', { content, extension })
    return res.path
  }


  async function exists(targetPath: string): Promise<boolean> {
    const res = await post<{ exists: boolean }>('/fs/exists', { path: targetPath })
    return res.exists
  }


  async function getHomePath(): Promise<string> {
    const res = await request<{ path: string }>('/fs/home-path')
    return res.path
  }


  function stat(targetPath: string) {
    return post<{ isDirectory: boolean; isFile: boolean; size: number; mtime: string }>('/fs/stat', {
      path: targetPath,
    })
  }


  // --- Chat History ---

  function chatHistoryGet(chatId: number, opts?: { before?: number; limit?: number }) {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.before !== undefined) params.set('before', String(opts.before))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request<{ messages: UIMessage[]; model?: string; providerId?: string; thinkingLevel?: string; modeId?: string; total?: number; hasMore?: boolean; nextCursor?: number; updatedAt?: number; sshEnvironment?: SshEnvironmentRef }>(
      `/chat-history/${chatId}${qs}`
    )
  }


  function chatHistoryClear(chatId: number) {
    return request<{ success: boolean }>(`/chat-history/${chatId}`, {
      method: 'DELETE',
    }).then((r) => r.success)
  }


  /**
   * Create the (empty) chat row backing a side chat branched off `parentChatId`.
   * The provider session is forked server-side on the first turn, not here.
   */
  function chatHistorySideCreate(parentChatId: number, title?: string) {
    return request<{ success: boolean; chatId?: number; error?: string }>('/chat-history/side', {
      method: 'POST',
      body: JSON.stringify({ parentChatId, ...(title ? { title } : {}) }),
    })
  }


  function chatHistoryList(
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
    return request<ChatHistoryItem[]>(`/chat-history${params}`)
  }


  async function workspaceChatHistoryPage(
    workspaceId: number,
    limit: number,
    page: string | number | null,
    signal: AbortSignal,
  ) {
    // The sidebar tree's rows: conversations, and agents started here from another machine
    // (no parent on this machine to list them under). A server without the flag ignores it.
    const params = new URLSearchParams({ workspaceId: String(workspaceId), tp: 'chat', remoteAgents: '1', limit: String(limit) })
    if (typeof page === 'number') params.set('offset', String(page))
    else params.set('cursor', page ?? '')

    const result = await request<{ items: ChatHistoryItem[]; nextCursor: string | null } | ChatHistoryItem[]>(
      `/chat-history?${params}`, { signal },
    )
    // Older web-connected nodes ignore cursor and return the legacy array.
    if (Array.isArray(result)) {
      return {
        items: result,
        nextCursor: result.length === limit ? (typeof page === 'number' ? page : 0) + result.length : null,
      }
    }
    return result
  }


  // --- AI turn control ---

  /**
   * End the turn running on this chat. The node keeps a turn alive when its
   * originating request drops — other surfaces may be attached to the same live
   * stream — so a deliberate Stop has to be signalled out-of-band like this.
   */
  function aiAbort(chatId: number) {
    return post<{ success: boolean }>('/ai/abort', { chatId })
  }


  // --- Channel / IM ---

  function agentList() {
    return request<{ agents: Agent[] }>('/agents')
  }


  function agentCreate(input: CreateAgentInput) {
    return request<{ agent: Agent }>('/agents', { method: 'POST', body: JSON.stringify(input) })
  }


  function agentGet(id: number) {
    return request<{ agent: Agent }>(`/agents/${id}`)
  }


  function agentUpdate(id: number, updates: UpdateAgentInput) {
    return request<{ agent: Agent }>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(updates) })
  }


  function agentDelete(id: number) {
    return request<{ success: boolean }>(`/agents/${id}`, { method: 'DELETE' })
  }


  /** The board and channel lists read one project's rows, or every project's when there is none. */
  function projectQuery(projectId: number | null): string {
    return projectId == null ? '' : `?projectId=${projectId}`
  }


  /** `projectId: null` → every project's channels. */
  function channelList(projectId: number | null) {
    return request<{ channels: Channel[] }>(`/channels${projectQuery(projectId)}`)
  }


  function channelCreate(input: CreateChannelInput) {
    return request<{ channel: Channel }>('/channels', { method: 'POST', body: JSON.stringify(input) })
  }


  function channelDelete(id: number) {
    return request<{ success: boolean }>(`/channels/${id}`, { method: 'DELETE' })
  }


  function channelMemberList(channelId: number) {
    return request<{ members: ChannelMember[] }>(`/channels/${channelId}/members`)
  }


  function channelMemberAdd(channelId: number, agentId: number) {
    return request<{ member: ChannelMember }>(`/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    })
  }


  function channelMemberRemove(channelId: number, agentId: number) {
    return request<{ success: boolean }>(`/channels/${channelId}/members/${agentId}`, { method: 'DELETE' })
  }


  function channelMessageList(channelId: number, opts?: { before?: number; limit?: number }) {
    const params = new URLSearchParams()
    if (opts?.before !== undefined) params.set('before', String(opts.before))
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    return request<{ messages: ChannelMessage[]; hasMore: boolean }>(`/channels/${channelId}/messages${qs}`)
  }


  function channelMessageCreate(channelId: number, body: Omit<CreateMessageInput, 'channelId'>) {
    return request<{ message: ChannelMessage }>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }


  function channelThreadReplies(channelId: number, messageId: number) {
    return request<{ replies: ChannelMessage[] }>(`/channels/${channelId}/messages/${messageId}/replies`)
  }


  function channelWaitingSessions(channelId: number) {
    return request<{ waiting: WaitingSession[] }>(`/channels/${channelId}/waiting`)
  }


  function channelWorkingAgents(channelId: number) {
    return request<{ agentIds: number[] }>(`/channels/${channelId}/working`)
  }


  function channelThreadList(channelId: number) {
    return request<{ threads: ChannelThread[] }>(`/channels/${channelId}/threads`)
  }


  /** Every channel with unread for the person (main timeline or threads). */
  function channelUnreadList() {
    return request<{ channels: ChannelUnread[] }>('/channels/unread')
  }


  /** Read the channel up to `upTo` (default: its latest message). */
  function channelMarkRead(channelId: number, upTo?: number) {
    return request<{ success: boolean }>(`/channels/${channelId}/read`, { method: 'POST', body: JSON.stringify(upTo != null ? { upTo } : {}) })
  }


  function channelThreadMarkRead(channelId: number, rootMessageId: number, upTo?: number) {
    return request<{ success: boolean }>(`/channels/${channelId}/threads/${rootMessageId}/read`, { method: 'POST', body: JSON.stringify(upTo != null ? { upTo } : {}) })
  }


  function channelThreadMemberRemove(channelId: number, rootMessageId: number, agentId: number) {
    return request<{ success: boolean }>(`/channels/${channelId}/threads/${rootMessageId}/members/${agentId}`, { method: 'DELETE' })
  }


  function channelThreadReply(channelId: number, messageId: number, body: Omit<CreateMessageInput, 'channelId' | 'threadRootId'>) {
    return request<{ message: ChannelMessage; threadRoot?: ThreadRootActivity }>(`/channels/${channelId}/messages/${messageId}/replies`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }


  function channelAgentSessions(projectId: number | null) {
    return request<{ sessions: AgentSession[] }>(`/channels/agents/sessions${projectQuery(projectId)}`)
  }


  async function channelStreamUrl(channelId: number): Promise<string> {
    const baseUrl = await getBaseUrl()
    return `${baseUrl}/channels/${channelId}/stream`
  }


  /** `projectId: null` → every project's tasks (the global board). */
  function taskList(projectId: number | null, filter: TaskListFilter = {}) {
    const params = new URLSearchParams()
    if (projectId != null) params.set('projectId', String(projectId))
    if (filter.status) params.set('status', filter.status)
    if (filter.assignedAgentId != null) params.set('assignee', String(filter.assignedAgentId))
    if (filter.labelId != null) params.set('label', String(filter.labelId))
    if (filter.priority != null) params.set('priority', String(filter.priority))
    if (filter.includeArchived) params.set('includeArchived', '1')
    return request<{ tasks: TaskListItem[] }>(`/tasks?${params.toString()}`)
  }


  function taskSetArchived(taskId: number, archived: boolean) {
    return request<{ task: TaskDetail; tasks?: TaskListItem[] }>(`/tasks/${taskId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    })
  }


  // ---- OperonSpec ----

  function specGet(taskId: number) {
    return request<{ spec: SpecView }>(`/spec/${taskId}`)
  }


  /** `implementers`: provider to build each ticket, by ticket key; the rest get the spec's default. */
  function specApprove(taskId: number, implementers?: Record<string, string>, concurrency?: number) {
    return request<{ tickets: Array<{ id: number; number: number; title: string }> }>(`/spec/${taskId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ implementers, concurrency }),
    })
  }


  function specReapprove(taskId: number) {
    return request<{ ok: true }>(`/spec/${taskId}/reapprove`, { method: 'POST', body: '{}' })
  }


  function specRequestChanges(taskId: number, input: { comment: string; redesign?: boolean }) {
    return request<{ runId: string }>(`/spec/${taskId}/request-changes`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }


  function specAnswer(taskId: number, answers: string) {
    return request<{ runId: string }>(`/spec/${taskId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    })
  }


  /** Gate 2: merge the built and reviewed change into the default branch. */
  function specSignOff(taskId: number) {
    // `pending`: merging the default branch in conflicted and the coordinator took it on.
    return request<{ ok: true; pending?: string }>(`/spec/${taskId}/signoff`, { method: 'POST', body: '{}' })
  }


  function specResume(taskId: number) {
    return request<{ runId: string | null }>(`/spec/${taskId}/resume`, { method: 'POST', body: '{}' })
  }


  function specStop(taskId: number) {
    return request<{ stopped: boolean }>(`/spec/${taskId}/stop`, { method: 'POST', body: '{}' })
  }


  /** Move a role — or, with `ticketKey`, one ticket's implementer or reviewer — to another agent. */
  function specSwitch(taskId: number, input: { role: SpecRole; index?: number; ticketKey?: string; providerId: string; modelId?: string }) {
    return request<{ message: string }>(`/spec/${taskId}/switch`, { method: 'POST', body: JSON.stringify(input) })
  }


  function specAcceptProposal(taskId: number) {
    return request<{ message: string }>(`/spec/${taskId}/proposal/accept`, { method: 'POST', body: '{}' })
  }


  function specDismissProposal(taskId: number, note?: string) {
    return request<{ ok: true }>(`/spec/${taskId}/proposal/dismiss`, { method: 'POST', body: JSON.stringify({ note }) })
  }


  /** The specs a chat started that are not done yet, newest first. */
  function specListByChat(chatId: number) {
    return request<{ specs: Array<{ taskId: number; taskNumber: number; title: string; stage: SpecStage }> }>(`/spec/by-chat/${chatId}`)
  }


  function specGetRoleSettings() {
    return request<{ roles: SpecRoleSettings; available: string[] }>('/spec/settings/roles')
  }


  function specSaveRoleSettings(roles: SpecRoleSettings) {
    return request<{ roles: SpecRoleSettings }>('/spec/settings/roles', { method: 'PUT', body: JSON.stringify({ roles }) })
  }


  function taskGet(taskId: number) {
    return request<{ task: TaskDetail }>(`/tasks/${taskId}`)
  }


  /** The task that owns a dispatched worktree, or null for a plain workspace. */
  function taskGetByWorkspace(workspaceId: number) {
    return request<{ task: Task | null }>(`/tasks/by-workspace/${workspaceId}`)
  }


  /** The task a dispatched conversation works on, or null for any other chat. */
  function taskGetByChat(chatId: number) {
    return request<{ task: Task | null }>(`/tasks/by-chat/${chatId}`)
  }


  function taskCreate(input: CreateProjectTaskInput) {
    return request<{ task: TaskDetail }>(`/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }


  function taskUpdate(taskId: number, updates: UpdateProjectTaskInput & { actorName?: string }) {
    return request<{ task: TaskDetail }>(`/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
  }


  function taskComment(taskId: number, body: string, attachments?: TaskAttachment[], actorName?: string) {
    return request<{ activity: TaskActivity }>(`/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, actorName, attachments }),
    })
  }


  function inboxList(filter: InboxListFilter = {}) {
    const params = new URLSearchParams()
    if (filter.severity) params.set('severity', filter.severity)
    if (filter.unreadOnly) params.set('unreadOnly', '1')
    if (filter.cursor != null) params.set('cursor', String(filter.cursor))
    if (filter.limit != null) params.set('limit', String(filter.limit))
    const qs = params.toString()
    return request<InboxListPage>(`/inbox${qs ? `?${qs}` : ''}`)
  }


  function inboxCounts() {
    return request<UnreadCounts>('/inbox/counts')
  }


  function inboxMarkRead(payload: { ids?: number[]; sourceKeys?: string[]; sourcePrefix?: string; all?: boolean }) {
    return request<{ ids: number[] }>('/inbox/read', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }


  function inboxArchive(payload: { ids?: number[]; all?: boolean }) {
    return request<{ ids: number[] }>('/inbox/archive', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }


  function inboxSetViewing(payload: { clientId: string; chatIds: number[]; assistant?: boolean }) {
    return request<{ ok: boolean }>('/inbox/viewing', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }


  /** Confirm (each item with its agent and workspace) or dismiss a sub-task proposal from the task's agent. */
  function taskResolveProposal(
    taskId: number,
    activityId: number,
    body:
      | { action: 'dismiss' }
      | { action: 'confirm'; items: { title: string; description: string; assignedAgentId: number; workspaceMode: TaskWorkspaceMode }[] },
  ) {
    return request<{ task: TaskDetail }>(`/tasks/${taskId}/proposals/${activityId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }


  /** `workspace`: omit to run the way the task says (its workspaceMode). */
  function taskDispatch(
    taskId: number,
    assignedAgentId: number,
    workspace?: { workspaceMode?: TaskWorkspaceMode; workspaceId?: number },
  ) {
    return request<{ task: TaskDetail }>(`/tasks/${taskId}/dispatch`, {
      method: 'POST',
      body: JSON.stringify({ assignedAgentId, ...workspace }),
    })
  }


  function taskLabelList(projectId: number | null) {
    return request<{ labels: TaskLabel[] }>(`/tasks/labels${projectQuery(projectId)}`)
  }


  function taskLabelCreate(input: CreateTaskLabelInput) {
    return request<{ label: TaskLabel }>(`/tasks/labels`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }


  function agentStop(agentId: number, projectId: number | null) {
    return request<{ success: boolean }>(`/agents/${agentId}/stop${projectQuery(projectId)}`, { method: 'POST', body: '{}' })
  }


  function agentReset(agentId: number, projectId: number | null) {
    return request<{ success: boolean }>(`/agents/${agentId}/reset${projectQuery(projectId)}`, { method: 'POST', body: '{}' })
  }


  function agentListSessions(agentId: number) {
    return request<{ sessions: AgentBinding[] }>(`/agents/${agentId}/sessions`)
  }


  function bindingReset(bindingId: number) {
    return request<{ success: boolean }>(`/agent-bindings/${bindingId}/reset`, { method: 'POST', body: '{}' })
  }

  return {
    gitStatus,
    gitDiff,
    gitShow,
    gitStage,
    gitStageAll,
    gitUnstage,
    gitUnstageAll,
    gitListRemotes,
    gitCommit,
    gitGenerateCommitMessage,
    gitGeneratePrSummary,
    gitCheckout,
    gitCheckoutNewBranch,
    gitPushStatus,
    gitPush,
    gitWorktreeList,
    gitWorktreeAdd,
    gitWorktreeRemove,
    gitDiffStat,
    gitStatusWithDiffStat,
    gitBranches,
    gitCommits,
    gitDefaultBaseBranch,
    gitMergeBase,
    gitCommitParent,
    gitDiffRange,
    gitFileDiffRange,
    gitRestore,
    gitRestoreAll,
    readDir,
    searchFiles,
    findPaths,
    readFile,
    getFileUrl,
    writeFile,
    saveTempFile,
    exists,
    getHomePath,
    stat,
    chatHistoryGet,
    chatHistoryClear,
    chatHistorySideCreate,
    chatHistoryList,
    workspaceChatHistoryPage,
    aiAbort,
    agentList,
    agentCreate,
    agentGet,
    agentUpdate,
    agentDelete,
    channelList,
    channelCreate,
    channelDelete,
    channelMemberList,
    channelMemberAdd,
    channelMemberRemove,
    channelMessageList,
    channelMessageCreate,
    channelThreadReplies,
    channelWaitingSessions,
    channelWorkingAgents,
    channelThreadList,
    channelUnreadList,
    channelMarkRead,
    channelThreadMarkRead,
    channelThreadMemberRemove,
    channelThreadReply,
    channelAgentSessions,
    channelStreamUrl,
    taskList,
    taskSetArchived,
    specGet,
    specApprove,
    specReapprove,
    specRequestChanges,
    specAnswer,
    specSignOff,
    specResume,
    specStop,
    specSwitch,
    specAcceptProposal,
    specDismissProposal,
    specListByChat,
    specGetRoleSettings,
    specSaveRoleSettings,
    taskGet,
    taskGetByWorkspace,
    taskGetByChat,
    taskCreate,
    taskUpdate,
    taskComment,
    inboxList,
    inboxCounts,
    inboxMarkRead,
    inboxArchive,
    inboxSetViewing,
    taskResolveProposal,
    taskDispatch,
    taskLabelList,
    taskLabelCreate,
    agentStop,
    agentReset,
    agentListSessions,
    bindingReset,
  }
}

export type HttpClient = ReturnType<typeof createHttpClient>

const localHttpClient = createHttpClient(localTransport)
export const {
  gitStatus,
  gitDiff,
  gitShow,
  gitStage,
  gitStageAll,
  gitUnstage,
  gitUnstageAll,
  gitListRemotes,
  gitCommit,
  gitGenerateCommitMessage,
  gitGeneratePrSummary,
  gitCheckout,
  gitCheckoutNewBranch,
  gitPushStatus,
  gitPush,
  gitWorktreeList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitDiffStat,
  gitStatusWithDiffStat,
  gitBranches,
  gitCommits,
  gitDefaultBaseBranch,
  gitMergeBase,
  gitCommitParent,
  gitDiffRange,
  gitFileDiffRange,
  gitRestore,
  gitRestoreAll,
  readDir,
  searchFiles,
  findPaths,
  readFile,
  getFileUrl,
  writeFile,
  saveTempFile,
  exists,
  getHomePath,
  stat,
  chatHistoryGet,
  chatHistoryClear,
  chatHistorySideCreate,
  chatHistoryList,
  workspaceChatHistoryPage,
  aiAbort,
  agentList,
  agentCreate,
  agentGet,
  agentUpdate,
  agentDelete,
  channelList,
  channelCreate,
  channelDelete,
  channelMemberList,
  channelMemberAdd,
  channelMemberRemove,
  channelMessageList,
  channelMessageCreate,
  channelThreadReplies,
  channelWaitingSessions,
  channelWorkingAgents,
  channelThreadList,
  channelUnreadList,
  channelMarkRead,
  channelThreadMarkRead,
  channelThreadMemberRemove,
  channelThreadReply,
  channelAgentSessions,
  channelStreamUrl,
  taskList,
  taskSetArchived,
  specGet,
  specApprove,
  specReapprove,
  specRequestChanges,
  specAnswer,
  specSignOff,
  specResume,
  specStop,
  specSwitch,
  specAcceptProposal,
  specDismissProposal,
  specListByChat,
  specGetRoleSettings,
  specSaveRoleSettings,
  taskGet,
  taskGetByWorkspace,
  taskGetByChat,
  taskCreate,
  taskUpdate,
  taskComment,
  inboxList,
  inboxCounts,
  inboxMarkRead,
  inboxArchive,
  inboxSetViewing,
  taskResolveProposal,
  taskDispatch,
  taskLabelList,
  taskLabelCreate,
  agentStop,
  agentReset,
  agentListSessions,
  bindingReset,
} = localHttpClient
