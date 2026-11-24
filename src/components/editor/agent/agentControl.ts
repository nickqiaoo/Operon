import { apiOn } from '@/lib/chat-api-context'
import type { ChatRef } from '@/lib/chat-ref'
import type { PeersRosterDTO } from '@/types/peers'
import type { OperonPluginDTO } from '@/types/plugin'

/**
 * Typed client for the Session panel's provider runtime-control surface.
 * Operon-specific DTOs mirror `server/src/services/operon-runtime/control.ts`;
 * MCP status is shared by Operon, Claude Code, Codex, and OpenCode sessions.
 *
 * Each wrapper posts `{ chatId, method, params }` to `POST /api/ai/agent-control`
 * and unwraps the `{ success, data, error }` envelope — throwing on failure so
 * the AgentPanel's per-section loading/error handling can catch. Keep these DTOs
 * in lockstep with `control.ts`; that file is the source of truth.
 */

// ── DTOs (mirror of control.ts) ─────────────────────────────────────────────
export interface McpServerDTO {
  name: string
  transport?: 'stdio' | 'http' | 'sse' | 'sdk' | 'claudeai-proxy'
  status:
    | 'pending'
    | 'connected'
    | 'failed'
    | 'disabled'
    | 'needs-auth'
    | 'needs-client-registration'
    | 'cancelled'
  error?: string
}

/** One tool an MCP server exposes. */
export interface McpToolDTO {
  name: string
  description?: string
}

export interface OperonCronTaskDTO {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring: boolean
  lastFiredAt?: number
  nextFireAt: number | null
}

export interface OperonBackgroundTaskDTO {
  taskId: string
  kind: 'process' | 'agent' | 'question' | 'workflow' | 'code'
  description: string
  status: 'running' | 'completed' | 'failed' | 'paused' | 'timed_out' | 'killed' | 'lost'
  startedAt: number
  endedAt: number | null
  stopReason?: string
  /** The tool call that started it — how a chat's tool row finds its task. */
  toolCallId?: string
  command?: string
  pid?: number
  exitCode?: number | null
  /** Set on a Monitor's task. */
  monitor?: OperonMonitorInfoDTO
  agentId?: string
  subagentType?: string
  questionCount?: number
  workflowName?: string
  runId?: string
}

export interface OperonMonitorInfoDTO {
  eventsDelivered: number
  eventsSuppressed: number
  timeoutMs: number
  endedBy?: 'expired' | 'too_much_output'
}

export interface OperonSubagentDTO {
  agentId: string
  type: string
  address: string
  description?: string
  background: boolean
  status: 'running' | 'completed' | 'error' | 'paused' | 'cancelled' | 'lost'
  createdAt: number
  updatedAt: number
}

export interface OperonSkillDTO {
  name: string
  description: string
  /** Where it came from: `project` | `user` | `extra` | `builtin`. */
  source: string
  /** Absolute path of the skill's own file — what makes a row openable. */
  path?: string
  type?: string
  disableModelInvocation?: boolean
}

/** One source of truth with the Plugins page (`/api/plugins/list` answers the same shape). */
export type { OperonPluginDTO }

export interface OperonSessionExtensionDTO {
  id: string
  uses: string[]
  builtin: boolean
}

// ── dispatch helper ─────────────────────────────────────────────────────────
// `chat` names the machine too: the session runs where the chat lives.
async function call<T>(chat: ChatRef, method: string, params?: unknown): Promise<T> {
  const res = await apiOn(chat.nodeId).aiAgentControl<T>({ chatId: chat.chatId, method, params })
  if (!res.success) throw new Error(res.error || `agent control '${method}' failed`)
  return res.data as T
}

// ── MCP ──
export const mcpList = (chat: ChatRef) =>
  call<{ servers: McpServerDTO[] }>(chat, 'mcp.list')
export const mcpTools = (chat: ChatRef, name: string) =>
  call<{ tools: McpToolDTO[] }>(chat, 'mcp.tools', { name })
export const mcpReconnect = (chat: ChatRef, name: string) =>
  call<{ ok: true }>(chat, 'mcp.reconnect', { name })
export const mcpToggle = (chat: ChatRef, name: string, enabled: boolean) =>
  call<{ ok: true }>(chat, 'mcp.toggle', { name, enabled })

// ── Cron ──
export const cronList = (chat: ChatRef) =>
  call<{ tasks: OperonCronTaskDTO[] }>(chat, 'cron.list')
export const cronCreate = (chat: ChatRef,
  input: { cron: string; prompt: string; recurring?: boolean },
) => call<{ task: OperonCronTaskDTO }>(chat, 'cron.create', input)
export const cronDelete = (chat: ChatRef, id: string) =>
  call<{ deleted: boolean }>(chat, 'cron.delete', { id })

// ── Background tasks ──
export const tasksList = (chat: ChatRef) =>
  call<{ tasks: OperonBackgroundTaskDTO[] }>(chat, 'tasks.list')
/** Operon's own tasks answer with a string; Claude Code's with `null` when there is nothing to read yet. */
export const tasksOutput = (chat: ChatRef, taskId: string) =>
  call<{ output: string | null }>(chat, 'tasks.output', { taskId })
export const tasksStop = (chat: ChatRef, taskId: string, reason?: string) =>
  call<{ task?: OperonBackgroundTaskDTO | null }>(chat, 'tasks.stop', { taskId, reason })
/** Claude Code: drop the finished entries from the session's task list. */
export const tasksClearFinished = (chat: ChatRef) => call<{ ok: true }>(chat, 'tasks.clearFinished')

// ── Subagents ──
export const subagentsList = (chat: ChatRef) =>
  call<{ subagents: OperonSubagentDTO[] }>(chat, 'subagents.list')

// ── Skills ──
export const skillsList = (chat: ChatRef) =>
  call<{ skills: OperonSkillDTO[] }>(chat, 'skills.list')

// ── Plugins ──
export const pluginsList = (chat: ChatRef) =>
  call<{ plugins: OperonPluginDTO[] }>(chat, 'plugins.list')
export const pluginsSetEnabled = (chat: ChatRef, id: string, enabled: boolean) =>
  call<{ ok: true }>(chat, 'plugins.setEnabled', { id, enabled })

// ── Extensions (per-session view) ──
export const extensionsList = (chat: ChatRef) =>
  call<{ extensions: OperonSessionExtensionDTO[] }>(chat, 'extensions.list')

// ── Peers / teams ──
export const peersList = (chat: ChatRef) =>
  call<PeersRosterDTO>(chat, 'peers.list')
