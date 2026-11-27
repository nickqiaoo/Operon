import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import * as agent from '@/components/editor/agent/agentControl'
import { useInstalledPlugins } from './plugin-queries'
import { useChatRef } from './chat-api-context'
import { chatKey, type ChatRef } from './chat-ref'

/**
 * TanStack Query layer for the Session panel (AgentPanel): the live state of one
 * chat's agent session — MCP servers, background tasks, subagents, skills, cron,
 * extensions and the peers roster.
 *
 * Keys carry the provider as well as the chat: the same chat id under another
 * provider is another session, and must not show the previous one's lists. The
 * chat is a `ChatKey` (machine + id): a remote tab's session runs on its machine.
 *
 * The hooks take a bare chat id and resolve it on the machine of the tab they
 * run in (`useChatRef`), so call sites inside a chat tab need no machine.
 */
export const agentSessionKeys = {
  all: ['agent-session'] as const,
  session: (providerId: string | undefined, chat: ChatRef) => ['agent-session', providerId ?? 'none', chatKey(chat)] as const,
  section: (providerId: string | undefined, chat: ChatRef, section: AgentSessionSection) =>
    ['agent-session', providerId ?? 'none', chatKey(chat), section] as const,
  taskOutput: (providerId: string | undefined, chat: ChatRef, taskId: string) =>
    ['agent-session', providerId ?? 'none', chatKey(chat), 'task-output', taskId] as const,
}

/** A placeholder for disabled queries (no chat yet): never fetched. */
const NO_CHAT: ChatRef = { chatId: -1 }

/** How often an open, still-running task's output is re-read. */
const TASK_OUTPUT_POLL_MS = 1500
const MCP_POLL_MS = 15_000

/**
 * What a Claude Code task has printed (`tasks.output`): read while its row is
 * open, and re-read while it runs, so a background command's tail stays live.
 */
export function useTaskOutput(
  providerId: string | undefined,
  chatId: number,
  taskId: string,
  { enabled, live }: { enabled: boolean; live: boolean },
) {
  const chat = useChatRef(chatId) ?? NO_CHAT
  return useQuery({
    queryKey: agentSessionKeys.taskOutput(providerId, chat, taskId),
    queryFn: async () => (await agent.tasksOutput(chat, taskId)).output,
    enabled,
    refetchInterval: live ? TASK_OUTPUT_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

/** How often a chat row re-reads operon's task list while its task runs. */
const OPERON_TASK_POLL_MS = 3000
/** Re-reads while a just-started task has not shown up in the list yet. */
const OPERON_TASK_LOOKUPS = 3

/**
 * One operon background task, found by the tool call that started it — what a chat
 * row (a Monitor's) shows its live state from. Shares the Session panel's `tasks`
 * cache, so the two never disagree and an open panel's poll feeds the row too.
 *
 * Polls only while that task runs; a task not in the list (yet) gets a few lookups,
 * then the row stops asking — an old chat with no session behind it costs nothing.
 */
export function useOperonTask(
  providerId: string | undefined,
  chatId: number | undefined,
  toolCallId: string | undefined,
): agent.OperonBackgroundTaskDTO | undefined {
  const enabled = providerId === 'custom' && chatId != null && !!toolCallId
  const find = (data: { tasks: agent.OperonBackgroundTaskDTO[] } | undefined) =>
    data?.tasks.find((task) => task.toolCallId === toolCallId)
  const chat = useChatRef(chatId) ?? NO_CHAT
  const query = useQuery({
    queryKey: agentSessionKeys.section(providerId, chat, 'tasks'),
    queryFn: () => agent.tasksList(chat),
    enabled,
    select: find,
    refetchInterval: (q) => {
      const task = find(q.state.data)
      if (task) return task.status === 'running' ? OPERON_TASK_POLL_MS : false
      return q.state.dataUpdateCount + q.state.errorUpdateCount < OPERON_TASK_LOOKUPS ? OPERON_TASK_POLL_MS : false
    },
    refetchIntervalInBackground: false,
    retry: false,
  })
  return enabled ? query.data : undefined
}

type AgentSessionSection = 'mcp' | 'tasks' | 'subagents' | 'skills' | 'cron' | 'extensions' | 'peers'

/** What a panel section reads: the query collapsed to the few fields it renders. */
export interface SessionResource<T> {
  data: T | null
  /** The first load, or a refresh the user asked for — never a background poll tick. */
  loading: boolean
  error: string | null
  /** True once a fetch has finished, success or not — lets us tell "empty" from "not loaded yet". */
  settled: boolean
  reload: () => void
}

/** The slice of query state a `SessionResource` is folded from. */
type ResourceQueryState = Pick<UseQueryResult<unknown>, 'data' | 'error' | 'status' | 'fetchStatus' | 'errorUpdateCount'>

/**
 * Fold query state into the panel's read-out, holding the last error across
 * background polls.
 *
 * v5 resets a data-less query to `pending` on every refetch and clears `error`
 * while the request is in flight. A chat reopened from history has no runtime
 * session until its first message, so the panel polls "No active session"
 * every few seconds — without the hold, each tick would swap the whole panel
 * to its loading skeleton and back (a visible flash). The hold clears itself
 * when data arrives, or when a fresh query (another chat / provider, zero
 * failures so far) takes the hook's slot.
 */
export function foldResourceState(
  query: ResourceQueryState,
  lastError: string | null,
  reloading: boolean,
): { error: string | null; loading: boolean; settled: boolean } {
  const failedBefore = query.errorUpdateCount > 0
  return {
    error: query.error ? query.error.message : query.data === undefined && failedBefore ? lastError : null,
    // A poll of a query that never succeeded looks exactly like a first load
    // (`pending` + `fetching`); the failure count is what tells them apart.
    loading: (query.status === 'pending' && query.fetchStatus === 'fetching' && !failedBefore) || reloading,
    settled: query.status !== 'pending' || failedBefore,
  }
}

/**
 * Collapse a query to a `SessionResource`. Background polls stay silent (the
 * refresh button doesn't spin or disable every few seconds); only the first
 * load and an explicit `reload()` count as loading.
 */
function useResource<T>(query: UseQueryResult<T>, enabled: boolean): SessionResource<T> {
  const [reloading, setReloading] = useState(false)
  const { refetch } = query
  const lastError = useRef<string | null>(null)
  const state = foldResourceState(query, lastError.current, reloading)
  lastError.current = state.error
  return {
    data: query.data ?? null,
    ...state,
    reload: () => {
      // `refetch` ignores `enabled`: a closed panel / unsaved chat must not fire.
      if (!enabled) return
      setReloading(true)
      void refetch().finally(() => setReloading(false))
    },
  }
}

interface SectionOptions {
  enabled: boolean
  /** Re-poll interval; 0 = load once per session. */
  intervalMs: number
}

/** What the server answers for a chat that has no runtime session (yet, or any more). */
export const NO_SESSION = /no active session/i

/**
 * The poll interval, or none while the chat has no session: a chat reopened from
 * history has none until its next turn, and asking every few seconds until then
 * only fills the network log with 400s. `useAgentSessionState` asks again when a
 * turn starts.
 */
export function sectionPollInterval(intervalMs: number, error: Error | null): number | false {
  if (intervalMs <= 0) return false
  return error && NO_SESSION.test(error.message) ? false : intervalMs
}

function useSessionSection<T>(
  providerId: string | undefined,
  chat: ChatRef,
  section: AgentSessionSection,
  fetcher: (chat: ChatRef) => Promise<T>,
  { enabled, intervalMs }: SectionOptions,
): SessionResource<T> {
  const query = useQuery({
    queryKey: agentSessionKeys.section(providerId, chat, section),
    queryFn: () => fetcher(chat),
    enabled,
    refetchInterval: (query) => sectionPollInterval(intervalMs, query.state.error),
    // A hidden window doesn't burn requests.
    refetchIntervalInBackground: false,
    // "No session yet" comes back as an error the panel reads at once; retrying it only delays that.
    retry: false,
  })
  return useResource(query, enabled)
}

export interface AgentSessionState {
  mcp: SessionResource<{ servers: agent.McpServerDTO[] }>
  tasks: SessionResource<{ tasks: agent.OperonBackgroundTaskDTO[] }>
  subagents: SessionResource<{ subagents: agent.OperonSubagentDTO[] }>
  skills: SessionResource<{ skills: agent.OperonSkillDTO[] }>
  cron: SessionResource<{ tasks: agent.OperonCronTaskDTO[] }>
  extensions: SessionResource<{ extensions: agent.OperonSessionExtensionDTO[] }>
  peers: SessionResource<Awaited<ReturnType<typeof agent.peersList>>>
  plugins: SessionResource<agent.OperonPluginDTO[]>
}

/**
 * Everything the Session panel shows for one chat. MCP status exists for every
 * provider; the rest only for operon's own runtime (`fullInspector`).
 */
export function useAgentSessionState({
  providerId,
  chatId,
  open,
  fullInspector,
  pollMs,
  running = false,
}: {
  providerId: string | undefined
  chatId: number | undefined
  open: boolean
  fullInspector: boolean
  pollMs: number
  /** The chat has a turn in progress. A turn starting is when a missing session appears. */
  running?: boolean
}): AgentSessionState {
  const live = open && chatId != null
  const id = useChatRef(chatId) ?? NO_CHAT
  const full = live && fullInspector
  // Polling stops while the chat has no session; a turn starting brings one, so look again.
  const queryClient = useQueryClient()
  const chat = chatKey(id)
  useEffect(() => {
    if (!running || !live) return
    void queryClient.invalidateQueries({ queryKey: agentSessionKeys.session(providerId, id) })
    // `chat` stands for `id`, whose object identity may change without the chat changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, live, queryClient, providerId, chat])
  const pluginsQuery = useInstalledPlugins({ enabled: open && fullInspector })
  return {
    mcp: useSessionSection(providerId, id, 'mcp', agent.mcpList, {
      enabled: live,
      intervalMs: MCP_POLL_MS,
    }),
    tasks: useSessionSection(providerId, id, 'tasks', agent.tasksList, { enabled: full, intervalMs: pollMs }),
    subagents: useSessionSection(providerId, id, 'subagents', agent.subagentsList, { enabled: full, intervalMs: pollMs }),
    skills: useSessionSection(providerId, id, 'skills', agent.skillsList, { enabled: full, intervalMs: 0 }),
    cron: useSessionSection(providerId, id, 'cron', agent.cronList, { enabled: full, intervalMs: 0 }),
    extensions: useSessionSection(providerId, id, 'extensions', agent.extensionsList, { enabled: full, intervalMs: 0 }),
    // The roster changes on its own (teammates wake, finish, park) — live poll.
    peers: useSessionSection(providerId, id, 'peers', agent.peersList, { enabled: full, intervalMs: pollMs }),
    // Plugins are global (Settings → Operon), not per-session: share the Plugins page's cache,
    // so installing / toggling one there shows up here too.
    plugins: useResource(pluginsQuery, open && fullInspector),
  }
}
