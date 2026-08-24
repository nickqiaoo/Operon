import { api } from '@/lib/api'

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
  toolCount?: number
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
  kind: 'process' | 'agent' | 'question' | 'workflow'
  description: string
  status: 'running' | 'completed' | 'failed' | 'paused' | 'timed_out' | 'killed' | 'lost'
  startedAt: number
  endedAt: number | null
  stopReason?: string
  command?: string
  pid?: number
  exitCode?: number | null
  agentId?: string
  subagentType?: string
  questionCount?: number
  workflowName?: string
  runId?: string
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
  source: string
  type?: string
  disableModelInvocation?: boolean
}

export interface OperonPluginDTO {
  id: string
  displayName: string
  version?: string
  enabled: boolean
  state: 'ok' | 'error'
  skillCount: number
  mcpServerCount: number
  enabledMcpServerCount: number
  hasErrors: boolean
  source: string
}

// ── dispatch helper ─────────────────────────────────────────────────────────
async function call<T>(chatId: number, method: string, params?: unknown): Promise<T> {
  const res = await api.aiAgentControl<T>({ chatId, method, params })
  if (!res.success) throw new Error(res.error || `agent control '${method}' failed`)
  return res.data as T
}

// ── MCP ──
export const mcpList = (chatId: number) =>
  call<{ servers: McpServerDTO[] }>(chatId, 'mcp.list')
export const mcpReconnect = (chatId: number, name: string) =>
  call<{ ok: true }>(chatId, 'mcp.reconnect', { name })
export const mcpToggle = (chatId: number, name: string, enabled: boolean) =>
  call<{ ok: true }>(chatId, 'mcp.toggle', { name, enabled })

// ── Cron ──
export const cronList = (chatId: number) =>
  call<{ tasks: OperonCronTaskDTO[] }>(chatId, 'cron.list')
export const cronCreate = (
  chatId: number,
  input: { cron: string; prompt: string; recurring?: boolean },
) => call<{ task: OperonCronTaskDTO }>(chatId, 'cron.create', input)
export const cronDelete = (chatId: number, id: string) =>
  call<{ deleted: boolean }>(chatId, 'cron.delete', { id })

// ── Background tasks ──
export const tasksList = (chatId: number) =>
  call<{ tasks: OperonBackgroundTaskDTO[] }>(chatId, 'tasks.list')
export const tasksOutput = (chatId: number, taskId: string) =>
  call<{ output: string }>(chatId, 'tasks.output', { taskId })
export const tasksStop = (chatId: number, taskId: string, reason?: string) =>
  call<{ task: OperonBackgroundTaskDTO | null }>(chatId, 'tasks.stop', { taskId, reason })

// ── Subagents ──
export const subagentsList = (chatId: number) =>
  call<{ subagents: OperonSubagentDTO[] }>(chatId, 'subagents.list')

// ── Skills ──
export const skillsList = (chatId: number) =>
  call<{ skills: OperonSkillDTO[] }>(chatId, 'skills.list')
export const skillsActivate = (chatId: number, name: string, args?: string) =>
  call<{ activationId: string; skillName: string }>(chatId, 'skills.activate', { name, args })

// ── Plugins ──
export const pluginsList = (chatId: number) =>
  call<{ plugins: OperonPluginDTO[] }>(chatId, 'plugins.list')
export const pluginsSetEnabled = (chatId: number, id: string, enabled: boolean) =>
  call<{ ok: true }>(chatId, 'plugins.setEnabled', { id, enabled })
