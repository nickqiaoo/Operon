import type { CronHandle, HarnessSession } from 'operon-agents'

/**
 * The operon agent's runtime control surface, exposed to the chat UI's Agent
 * panel. Each method is a thin, serializable wrapper over a `HarnessSession`
 * capability — the same facade the harness exposes (MCP / cron / background
 * tasks / subagents / skills / plugins). Adding a capability = one `case` here +
 * a panel section in the desktop chat UI.
 *
 * Transport-agnostic: `session-ops.agentControl(chatId, method, params)` calls
 * in, JSON comes out. `params`/return are JSON-serializable so this stays usable
 * over any boundary (the desktop chat panel drives it via an HTTP route). Wire
 * DTOs are declared here; element types are derived from the harness method
 * returns so we never depend on a type's exact re-export path.
 */

type McpServerView = Awaited<ReturnType<HarnessSession['listMcpServers']>>[number]
type CronTask = ReturnType<CronHandle['listTasks']>[number]
type BackgroundTaskInfo = Awaited<ReturnType<HarnessSession['listBackgroundTasks']>>[number]
type SubagentRecord = Awaited<ReturnType<HarnessSession['listSubagents']>>[number]
type SkillSummary = Awaited<ReturnType<HarnessSession['listSkills']>>[number]
type PluginSummary = Awaited<ReturnType<HarnessSession['listPlugins']>>[number]

// ── DTOs ───────────────────────────────────────────────────────────────────
export interface OperonMcpServerDTO {
  name: string
  transport: 'stdio' | 'http'
  status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth'
  error?: string
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
  // kind-specific extras (flattened; present only for the matching kind)
  command?: string
  /**
   * No `pid`. A background command is driven by a CommandStarter, not a process
   * handle — sandbox transports have no honest pid to report — so the framework
   * stopped exposing one. Nothing here read it.
   */
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

/**
 * Dispatch one control method against the session's harness. Throws on an
 * unknown method or bad params; the caller (session-ops) turns that into an
 * error reply.
 */
export async function operonAgentControl(
  harness: HarnessSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    // ── MCP ──
    case 'mcp.list':
      return { servers: harness.listMcpServers().map(toMcpDTO) }
    case 'mcp.reconnect':
      await harness.reconnectMcpServer(readString(params, 'name'))
      return { ok: true }

    // ── Cron ──
    // Cron moved off the session facade onto the extension channel: the local
    // deployment profile attaches `cronExtension()`, and hosts drive it through
    // `extensionHandle('cron')`. A session without the extension (server profile)
    // reports cron as unavailable instead of silently no-oping.
    case 'cron.list': {
      const cron = cronHandle(harness)
      return { tasks: cron.listTasks().map((t) => toCronDTO(t, cron.getNextFireTime(t.id))) }
    }
    case 'cron.create': {
      const cron = cronHandle(harness)
      const task = cron.addTask({
        cron: readString(params, 'cron'),
        prompt: readString(params, 'prompt'),
        recurring: readBool(params, 'recurring') ?? true,
      })
      return { task: toCronDTO(task, cron.getNextFireTime(task.id)) }
    }
    case 'cron.delete':
      return { deleted: cronHandle(harness).removeTask(readString(params, 'id')) }

    // ── Background tasks ──
    case 'tasks.list': {
      const tasks = await harness.listBackgroundTasks()
      return { tasks: tasks.map(toBackgroundDTO) }
    }
    case 'tasks.output':
      // The framework returns a bounded snapshot (content + size/truncation metadata);
      // this control channel only surfaces the window itself.
      return { output: (await harness.readBackgroundTaskOutput(readString(params, 'taskId'))).content }
    case 'tasks.stop': {
      const task = await harness.stopBackgroundTask(
        readString(params, 'taskId'),
        readOptionalString(params, 'reason'),
      )
      return { task: task ? toBackgroundDTO(task) : null }
    }

    // ── Subagents ──
    case 'subagents.list':
      return { subagents: (await harness.listSubagents()).map(toSubagentDTO) }

    // ── Skills ──
    case 'skills.list':
      return { skills: (await harness.listSkills()).map(toSkillDTO) }
    case 'skills.activate': {
      const args = readOptionalString(params, 'args')
      const result = await harness.activateSkill({
        name: readString(params, 'name'),
        ...(args ? { args } : {}),
      })
      return { activationId: result.activationId, skillName: result.skillName }
    }

    // ── Plugins ──
    case 'plugins.list':
      return { plugins: (await harness.listPlugins()).map(toPluginDTO) }
    case 'plugins.setEnabled':
      await harness.setPluginEnabled(readString(params, 'id'), readBool(params, 'enabled') ?? false)
      return { ok: true }
    case 'plugins.setMcpEnabled':
      await harness.setPluginMcpServerEnabled(
        readString(params, 'id'),
        readString(params, 'server'),
        readBool(params, 'enabled') ?? false,
      )
      return { ok: true }
    case 'plugins.install':
      return { plugin: toPluginDTO(await harness.installPlugin(readString(params, 'source'))) }
    case 'plugins.remove':
      await harness.removePlugin(readString(params, 'id'))
      return { ok: true }
    case 'plugins.reload':
      await harness.reloadPlugins()
      return { ok: true }

    default:
      throw new Error(`Unknown agent control method: ${method}`)
  }
}

function cronHandle(harness: HarnessSession): CronHandle {
  const handle = harness.extensionHandle<CronHandle>('cron')
  if (!handle) throw new Error('Cron is not available for this session (cron extension not attached)')
  return handle
}

// ── mappers ──────────────────────────────────────────────────────────────
function toMcpDTO(v: McpServerView): OperonMcpServerDTO {
  return {
    name: v.name,
    transport: v.transport,
    status: v.status,
    ...(v.error ? { error: v.error } : {}),
  }
}

function toCronDTO(t: CronTask, nextFireAt: number | null): OperonCronTaskDTO {
  return {
    id: t.id,
    cron: t.cron,
    prompt: t.prompt,
    createdAt: t.createdAt,
    recurring: t.recurring ?? false,
    ...(t.lastFiredAt !== undefined ? { lastFiredAt: t.lastFiredAt } : {}),
    nextFireAt,
  }
}

function toBackgroundDTO(t: BackgroundTaskInfo): OperonBackgroundTaskDTO {
  const base: OperonBackgroundTaskDTO = {
    taskId: t.taskId,
    kind: t.kind,
    description: t.description,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ...(t.stopReason ? { stopReason: t.stopReason } : {}),
  }
  if (t.kind === 'process') {
    return { ...base, command: t.command, exitCode: t.exitCode }
  }
  if (t.kind === 'agent') {
    return {
      ...base,
      ...(t.agentId ? { agentId: t.agentId } : {}),
      ...(t.subagentType ? { subagentType: t.subagentType } : {}),
    }
  }
  if (t.kind === 'question') {
    return { ...base, questionCount: t.questionCount }
  }
  return {
    ...base,
    ...(t.workflowName ? { workflowName: t.workflowName } : {}),
    ...(t.runId ? { runId: t.runId } : {}),
  }
}

function toSubagentDTO(s: SubagentRecord): OperonSubagentDTO {
  return {
    agentId: s.agentId,
    type: s.type,
    address: s.address,
    ...(s.description ? { description: s.description } : {}),
    background: s.background,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

function toSkillDTO(s: SkillSummary): OperonSkillDTO {
  return {
    name: s.name,
    description: s.description,
    source: String(s.source),
    ...(s.type ? { type: s.type } : {}),
    ...(s.disableModelInvocation !== undefined ? { disableModelInvocation: s.disableModelInvocation } : {}),
  }
}

function toPluginDTO(p: PluginSummary): OperonPluginDTO {
  return {
    id: p.id,
    displayName: p.displayName,
    ...(p.version ? { version: p.version } : {}),
    enabled: p.enabled,
    state: p.state,
    skillCount: p.skillCount,
    mcpServerCount: p.mcpServerCount,
    enabledMcpServerCount: p.enabledMcpServerCount,
    hasErrors: p.hasErrors,
    source: String(p.source),
  }
}

// ── param readers ────────────────────────────────────────────────────────
function readString(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent control: missing string param '${key}'`)
  }
  return value
}

function readOptionalString(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readBool(params: unknown, key: string): boolean | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'boolean' ? value : undefined
}
