import { useRef, useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import * as agent from '@/components/editor/agent/agentControl'
import { useInstalledPlugins } from './plugin-queries'

/**
 * TanStack Query layer for the Session panel (AgentPanel): the live state of one
 * chat's agent session — MCP servers, background tasks, subagents, skills, cron,
 * extensions and the peers roster.
 *
 * Keys carry the provider as well as the chat: the same chat id under another
 * provider is another session, and must not show the previous one's lists.
 */
export const agentSessionKeys = {
  all: ['agent-session'] as const,
  session: (providerId: string | undefined, chatId: number) => ['agent-session', providerId ?? 'none', chatId] as const,
  section: (providerId: string | undefined, chatId: number, section: AgentSessionSection) =>
    ['agent-session', providerId ?? 'none', chatId, section] as const,
  taskOutput: (providerId: string | undefined, chatId: number, taskId: string) =>
    ['agent-session', providerId ?? 'none', chatId, 'task-output', taskId] as const,
}

/** How often an open, still-running task's output is re-read. */
const TASK_OUTPUT_POLL_MS = 1500

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
  return useQuery({
    queryKey: agentSessionKeys.taskOutput(providerId, chatId, taskId),
    queryFn: async () => (await agent.tasksOutput(chatId, taskId)).output,
    enabled,
    refetchInterval: live ? TASK_OUTPUT_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
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

function useSessionSection<T>(
  providerId: string | undefined,
  chatId: number,
  section: AgentSessionSection,
  fetcher: (chatId: number) => Promise<T>,
  { enabled, intervalMs }: SectionOptions,
): SessionResource<T> {
  const query = useQuery({
    queryKey: agentSessionKeys.section(providerId, chatId, section),
    queryFn: () => fetcher(chatId),
    enabled,
    refetchInterval: intervalMs > 0 ? intervalMs : false,
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
}: {
  providerId: string | undefined
  chatId: number | undefined
  open: boolean
  fullInspector: boolean
  pollMs: number
}): AgentSessionState {
  const live = open && chatId != null
  const id = chatId ?? -1
  const full = live && fullInspector
  const pluginsQuery = useInstalledPlugins({ enabled: open && fullInspector })
  return {
    mcp: useSessionSection(providerId, id, 'mcp', agent.mcpList, { enabled: live, intervalMs: pollMs }),
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
