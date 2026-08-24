import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { UIMessage } from 'ai'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { ChannelMessage } from '../../types/channel.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import { emitChannelEvent, emitProjectEvent } from '../channel-bus.js'
import { startChat } from '../ai.js'
import {
  commit,
  getDefaultBaseBranch,
  getStatus,
  mergeBranch,
  worktreeAdd,
  worktreeRemove,
  deleteLocalBranch,
  worktreeList,
} from '../git.js'
import { worktreePathFor, sanitizeSegment } from '../worktree-paths.js'
import { broadcastTask } from '../task-events.js'
import { SDD_CREATE_SPEC_TASK_HINT, SDD_WORKFLOW_PROMPT } from '../sdd/sdd-prompt.js'
import {
  changeBranchName,
  mergeChildIntoParent,
  nextDispatchableChildren,
  sedimentChange,
  approveArtifact,
  writeArtifact,
  assertGateOrThrow,
  detectAndApplyDrift,
  GateError,
  type ArtifactActor,
  type GateBlock,
} from '../sdd/sdd-service.js'
import type { TaskStatus } from '../../types/task.js'
import { deliverToBinding } from '../message-router.js'
import {
  deliverBinding,
  handleBindingFinish as driverHandleFinish,
  registerBindingAdapter,
  initBindingFinishDispatch,
  MAX_IDLE_RETRIES,
  type BindingPlatformAdapter,
} from '../binding-driver.js'
import {
  buildAgentSystemPrompt,
  buildWakeUpPrompt,
  FIRST_STARTUP_PROMPT,
  RECOVERY_PROMPT,
} from './agent-system-prompt.js'
import { resolveAgentEnv } from './agent-env.js'

type Storage = ChannelStorageAdapter & ProjectStorageAdapter & AgentBindingStorageAdapter & TaskStorageAdapter

const DEBOUNCE_MS = 3000
/** Context usage threshold (0-1) above which auto-compact is triggered for providers that don't auto-compact */
const AUTO_COMPACT_THRESHOLD = 0.8
/** Providers that handle compaction internally and don't need orchestrator-triggered compact */
const SELF_COMPACTING_PROVIDERS = new Set(['gemini', 'opencode'])

let _storage: Storage | null = null

// ---- Public helpers ----

/** Returns true if the given chatId belongs to an app binding (should not be destroyed by tab close). */
export function isAgentOwnedChat(chatId: number): boolean {
  if (!_storage) return false
  const binding = _storage.getBindingByActiveChatId(chatId)
  return binding != null && binding.scopeKind === 'app'
}

// ---- Public init ----

export function initOrchestrator(storage: Storage): void {
  _storage = storage
  registerBindingAdapter(channelAdapter)
  registerBindingAdapter(taskFinishAdapter)
  initBindingFinishDispatch(storage)
}

// ---- Binding lifecycle ----

/**
 * Look up the (agent × channel) binding, creating it on first encounter.
 * Workspace is shared per-(agent, project) — multiple bindings of the same
 * agent in the same project point at the same workspace_id.
 */
function ensureChannelBinding(
  storage: Storage,
  channelId: number,
  channelName: string,
  projectId: number,
  agentId: number,
): AgentBinding {
  const existing = storage.getBindingByScope('app', String(channelId), agentId)
  if (existing) return existing

  // Reuse this agent's workspace_id from any other binding in the same project.
  const peerBindings = storage.listBindings({
    scopeKind: 'app',
    agentId,
    projectId,
  })
  const sharedWorkspaceId = peerBindings.find((b) => b.workspaceId != null)?.workspaceId ?? null

  return storage.upsertBinding({
    agentId,
    scopeKind: 'app',
    scopeKey: String(channelId),
    scopeDisplayName: `#${channelName}`,
    channelKind: 'channel',
    projectId,
    workspaceId: sharedWorkspaceId,
    status: 'offline',
  })
}

// ---- Core routing ----

/**
 * Route a newly created channel message to all agent members.
 * Called after every human/agent message is persisted.
 * Fire-and-forget from the route handler.
 */
export async function routeMessageToAgents(
  channelId: number,
  message: ChannelMessage,
): Promise<void> {
  const storage = _storage
  if (!storage) {
    console.warn('[Orchestrator] routeMessageToAgents: storage not initialised')
    return
  }

  const channel = storage.getChannel(channelId)
  if (!channel) {
    console.warn(`[Orchestrator] routeMessageToAgents: channel ${channelId} not found`)
    return
  }

  const members = storage.listMembers(channelId)
  console.log(
    `[Orchestrator] routeMessageToAgents: channel=#${channel.name} msgId=${message.id} ` +
      `sender=${message.senderName} agents=[${members.map((m) => m.agentId).join(',')}]`,
  )

  for (const member of members) {
    const { agentId } = member

    // Don't echo back to the sender
    if (message.senderType === 'agent' && message.senderId === agentId) continue

    const binding = ensureChannelBinding(storage, channelId, channel.name, channel.projectId, agentId)

    try {
      await deliverBinding(storage, channelAdapter, binding)
    } catch (err) {
      console.error(`[Orchestrator] routeMessageToAgents error for agent ${agentId}:`, err)
    }
  }
}

// ---- Worktree lifecycle ----

/**
 * Provision (or reuse) the agent's permanent worktree for this project,
 * returning the workspace_id. Called from message-router for offline
 * bindings that have no workspace_id yet.
 *
 * Reuses the workspace_id of any other (agent, project) binding when present.
 */
async function provisionWorkspaceForBinding(agentId: number, projectId: number): Promise<number> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  // Reuse from any other binding of (agent, project) — there might already
  // be a workspace registered in the workspaces table even if this binding
  // didn't pick it up yet.
  const peers = storage.listBindings({ agentId, projectId })
  const existingWs = peers.find((b) => b.workspaceId != null)?.workspaceId
  if (existingWs != null) return existingWs

  const workspace = await provisionAgentWorkspace(agentId, projectId)
  return workspace.id
}

/**
 * Public alias for callers that want to ensure a worktree without going via
 * the message-router path (e.g. dispatchTask).
 */
export async function ensureAgentWorktree(agentId: number, projectId: number): Promise<void> {
  await provisionWorkspaceForBinding(agentId, projectId)
}

/**
 * Create a git worktree + workspace row for an agent in a project, seeding
 * .agent-memory/ files. Idempotent at the git layer (reuses existing worktree
 * when the branch already exists), but every call registers a new workspace
 * row — callers must decide if they already have one.
 *
 * `suffix` disambiguates worktree path + branch when the same agent needs
 * multiple worktrees in the same project (e.g. one per IM channel, one per
 * task). Worktrees live under ~/.operon/worktrees/<projectId>-<repo>/ (see
 * worktree-paths.ts), not in the repo's sibling directory.
 *
 * `branchName` / `baseBranch` / `worktreeName` override the default per-agent
 * naming — used by SDD child dispatch to put a change-scoped branch
 * (`operon/task-<N>`) cut off the parent change branch into a change-scoped
 * worktree, so the branch belongs to the change (survives author→executor
 * handoff), not the agent (§5.3).
 */
export async function provisionAgentWorkspace(
  agentId: number,
  projectId: number,
  options: {
    suffix?: string
    workspaceName?: string
    branchName?: string
    baseBranch?: string
    worktreeName?: string
  } = {},
) {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  const agent = storage.getAgent(agentId)
  const project = storage.getProject(projectId)
  if (!agent || !project) throw new Error(`Agent ${agentId} or project ${projectId} not found`)

  // Collision-proof identity: agent and work-context live in SEPARATE path
  // segments (real '/'), and the agent segment is prefixed with the globally
  // unique agent id. So distinct agents never collide (distinct id prefix), and
  // a sanitized name can't bleed into the context segment (no '/' survives
  // sanitize) — e.g. an agent literally named "claude-task-3" can't clash with
  // agent "claude"'s task #3.
  const repoPath = project.rootPath
  const agentSeg = `${agentId}-${sanitizeSegment(agent.name)}`
  const context = options.suffix ? sanitizeSegment(options.suffix) : 'main'
  const branchName = options.branchName ?? `operon/${agentSeg}/${context}`
  const worktreeRel = options.worktreeName ?? path.join(agentSeg, context)
  const worktreePath = worktreePathFor(projectId, repoPath, worktreeRel)

  // git worktree add won't create missing parent dirs — ensure the agent's
  // worktree directory exists first.
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })

  // A worktree may already be checked out at this path — from a prior session, a
  // restart, or an orphaned pointer left after its owning binding was deleted
  // (the workspace is shared per-(agent, project), so losing the last binding
  // that referenced it doesn't remove the git worktree). `git worktree add`
  // refuses an already-registered path with a fatal "already exists", and the
  // no-branch retry below would hit the same wall — so reuse it instead of
  // recreating. Only add when this path isn't registered yet.
  const alreadyRegistered = (await worktreeList(repoPath)).some(
    (w) => path.resolve(w.path) === path.resolve(worktreePath),
  )
  if (!alreadyRegistered) {
    // Create the git worktree (idempotent — catches "already checked out" error).
    // baseBranch (when given) is the ref the new branch is cut from.
    try {
      await worktreeAdd(repoPath, worktreePath, branchName, true, options.baseBranch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists')) {
        // Branch exists but has no worktree yet — check it out without -b.
        await worktreeAdd(repoPath, worktreePath, branchName, false)
      } else if (!msg.includes('already checked out')) {
        throw err
      }
    }
  }

  const memoryDir = path.join(worktreePath, '.agent-memory')
  await fs.mkdir(memoryDir, { recursive: true })
  await fs.mkdir(path.join(memoryDir, 'notes'), { recursive: true })

  const memoryMd = `# ${agent.name}\n\n## Role\n${agent.instructions || 'No role defined yet.'}\n\n## Key Knowledge\n- No notes yet.\n\n## Active Context\n- First startup.\n`
  const memoryPath = path.join(memoryDir, 'MEMORY.md')
  try {
    await fs.access(memoryPath)
  } catch {
    await fs.writeFile(memoryPath, memoryMd, 'utf-8')
  }

  const gitignorePath = path.join(worktreePath, '.gitignore')
  try {
    const existing = await fs.readFile(gitignorePath, 'utf-8')
    if (!existing.includes('.agent-memory')) {
      await fs.appendFile(gitignorePath, '\n.agent-memory/\n', 'utf-8')
    }
  } catch {
    await fs.writeFile(gitignorePath, '.agent-memory/\n', 'utf-8')
  }

  // One workspace row per worktree path: reuse the row if this worktree already
  // has one (a re-dispatch of the same task resolves to the same path), so
  // re-provisioning never leaves orphan rows behind.
  const workspace =
    storage.listWorkspaces(projectId).find((w) => w.worktreePath === worktreePath) ??
    storage.createWorkspace(projectId, {
      name: options.workspaceName ?? `${agent.name} (agent)`,
      branchName,
      worktreePath,
    })
  console.log(
    `[Orchestrator] provisionAgentWorkspace: agent=${agentId} project=${projectId} ` +
      `workspace=${workspace.id} path=${worktreePath}`,
  )
  return workspace
}

// ---- Chat start ----

/**
 * Start a fresh chat for a per-channel app binding.
 * Returns the new chat id; caller (message-router) writes it back to the binding.
 */
async function startBindingChat(
  binding: AgentBinding,
  prompt: string,
  workspaceId: number | null,
  isRecovery: boolean,
): Promise<number> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')
  if (binding.projectId == null) {
    throw new Error(`binding ${binding.id} has no project_id — cannot start chat`)
  }

  const agent = storage.getAgent(binding.agentId)
  if (!agent) throw new Error(`agent ${binding.agentId} not found for binding ${binding.id}`)

  const isFirstStartup = binding.activeChatId == null && !isRecovery
  console.log(
    `[Orchestrator] startBindingChat: binding=${binding.id} scope=${binding.scopeDisplayName} ` +
      `agent=${agent.name}(${agent.id}) firstStartup=${isFirstStartup} chatId=${binding.activeChatId ?? 'none'}`,
  )

  // SDD prompt layering (§9/§11.2). No per-agent capability gate:
  //  - Task executor on an SDD task → the FULL workflow rules (any executor must
  //    follow the gates / acceptance / sediment discipline from the start).
  //  - Channel (app) agent → a LIGHT hint that create_spec_task exists and when to
  //    reach for it. The full rules are delivered at promote time (in the
  //    create_spec_task result), not pre-armed by any channel "mode".
  // Racing promotes are handled by dedup in promoteToTask, not by pre-marking one
  // agent. §13 ①: living specs live in `.operon/specs/*.md` in the worktree; the
  // prompt tells the agent to read them on demand rather than dumping into context.
  // Persona + SDD layering travel as session instructions, re-derived on EVERY
  // start (not just first startup) — providers bake instructions at session
  // creation and resume does not restore a previous value.
  let instructions = buildAgentSystemPrompt(agent)
  const taskSddManaged =
    binding.scopeKind === 'task' && !!storage.taskGet(Number(binding.scopeKey))?.sddManaged
  if (taskSddManaged) {
    instructions += `\n\n${SDD_WORKFLOW_PROMPT}`
  } else if (binding.scopeKind === 'app') {
    instructions += `\n\n${SDD_CREATE_SPEC_TASK_HINT}`
  }

  const messages: UIMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    },
  ]

  emitProjectEvent(binding.projectId, {
    type: 'agent_status',
    agentId: agent.id,
    projectId: binding.projectId,
    status: 'active',
  })

  let ctx
  try {
    ctx = await startChat({
      chatId: binding.activeChatId ?? undefined,
      messages,
      providerId: agent.provider,
      modelId: agent.model,
      modeId: agent.permissionMode || undefined,
      workspaceId: workspaceId ?? undefined,
      env: resolveAgentEnv(agent),
      instructions,
      agentContext: {
        agentId: agent.id,
        projectId: binding.projectId,
        // App-scoped bindings are channel sessions: scopeKey is the channel id.
        // Forwarded to taskboard so SDD create_spec_task derives its channel here
        // instead of trusting a (frequently wrong) model-supplied id.
        channelId: binding.scopeKind === 'app' ? Number(binding.scopeKey) : undefined,
        // Team tasks get the inbox MCP for private peer coordination (gated on a
        // team label, mirroring Linear's team:<name> opt-in).
        inboxAgentSessionId:
          binding.scopeKind === 'task' && binding.teamLabel
            ? binding.agentSessionId ?? undefined
            : undefined,
      },
    })
  } catch (err) {
    console.error(
      `[Orchestrator] startBindingChat: agent=${agent.name} binding=${binding.id} startChat FAILED:`,
      err,
    )
    storage.updateBinding(binding.id, { status: 'idle' })
    emitProjectEvent(binding.projectId, {
      type: 'agent_status',
      agentId: agent.id,
      projectId: binding.projectId,
      status: 'idle',
    })

    // Surface the error in the channel (app scope only — task/linear bindings
    // have no channel to post into; scopeKey is a task id / session id there).
    const errMsg = err instanceof Error ? err.message : String(err)
    const channelId = Number(binding.scopeKey)
    if (binding.scopeKind === 'app' && Number.isFinite(channelId)) {
      const sysMsg = storage.createMessage({
        channelId,
        senderType: 'system',
        senderName: 'system',
        content: `${agent.name} failed to start: ${errMsg}`,
      })
      emitChannelEvent(channelId, { type: 'channel_message', data: sysMsg })
    }
    throw err
  }

  console.log(
    `[Orchestrator] startBindingChat: binding=${binding.id} chat started chatId=${ctx.chatId}`,
  )
  drainAgentChat(ctx)
  return ctx.chatId
}

function drainAgentChat(ctx: Awaited<ReturnType<typeof startChat>>): void {
  console.log(`[Orchestrator] drainAgentChat: started for chatId=${ctx.chatId}`)
  ;(async () => {
    const reader = ctx.preparedParts.getReader()
    const errors: string[] = []
    let lastPercentUsed = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const part = value && typeof value === 'object' && 'part' in value
          ? (value as { part?: Record<string, unknown> }).part
          : value
        if (part && typeof part === 'object' && 'type' in part && part.type === 'error') {
          const errMsg =
            'error' in part && part.error instanceof Error
              ? part.error.message
              : String(part.error ?? 'Unknown error')
          errors.push(errMsg)
        }
        const metadata =
          value && typeof value === 'object' && 'metadata' in value
            ? (value as { metadata?: Record<string, unknown> }).metadata
            : undefined
        if (metadata) {
          const contextUsage = metadata.contextUsage as Record<string, number> | undefined
          if (contextUsage?.percentUsed != null) {
            lastPercentUsed = contextUsage.percentUsed
          }
        }
      }
    } finally {
      if (errors.length > 0) {
        console.error(
          `[Orchestrator] drainAgentChat: chatId=${ctx.chatId} stream errors: ${errors.join('; ')}`,
        )
      }
      console.log(
        `[Orchestrator] drainAgentChat: stream ended for chatId=${ctx.chatId}, ` +
          `contextUsage=${(lastPercentUsed * 100).toFixed(1)}%, persisting...`,
      )
      await ctx.persistDone
      ctx.finish()

      const storage = _storage
      if (!storage) return
      const binding = storage.getBindingByActiveChatId(ctx.chatId)
      if (!binding) {
        console.warn(`[Orchestrator] drainAgentChat: no binding for chatId=${ctx.chatId}`)
        return
      }

      // Surface provider errors as system messages in the channel
      if (errors.length > 0) {
        const agent = storage.getAgent(binding.agentId)
        const channelId = Number(binding.scopeKey)
        if (Number.isFinite(channelId)) {
          const sysMsg = storage.createMessage({
            channelId,
            senderType: 'system',
            senderName: 'system',
            content: `⚠ ${agent?.name ?? `Agent ${binding.agentId}`} provider error: ${errors.join('; ')}`,
          })
          emitChannelEvent(channelId, { type: 'channel_message', data: sysMsg })
        }
      }

      // Auto-compact if context usage exceeds threshold
      if (lastPercentUsed > AUTO_COMPACT_THRESHOLD) {
        const agent = storage.getAgent(binding.agentId)
        const providerId = agent?.provider ?? ''
        if (!SELF_COMPACTING_PROVIDERS.has(providerId)) {
          console.log(
            `[Orchestrator] drainAgentChat: context at ${(lastPercentUsed * 100).toFixed(1)}% ` +
              `for binding ${binding.id} (${providerId}), triggering auto-compact`,
          )
          await triggerAutoCompact(binding).catch((err) => {
            console.error(`[Orchestrator] auto-compact failed for binding ${binding.id}:`, err)
          })
        } else {
          console.log(
            `[Orchestrator] drainAgentChat: context at ${(lastPercentUsed * 100).toFixed(1)}% ` +
              `for binding ${binding.id} (${providerId}), skipping compact (provider self-compacts)`,
          )
        }
      }

      console.log(
        `[Orchestrator] drainAgentChat: chatId=${ctx.chatId} finished, triggering handleBindingFinish`,
      )
      handleBindingFinish(binding.id).catch((err) => {
        console.error('[Orchestrator] handleBindingFinish error:', err)
      })
    }
  })().catch((err) => {
    console.error('[Orchestrator] agent chat drain error:', err)
  })
}

/** Called by agent-recovery.ts on startup to resume an agent binding with a recovery prompt. */
export async function wakeUpBindingForRecovery(bindingId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const binding = storage.getBinding(bindingId)
  if (!binding || binding.scopeKind !== 'app') return

  const channelId = Number(binding.scopeKey)
  const channel = storage.getChannel(channelId)
  if (!channel) return

  let workspaceId = binding.workspaceId
  if (workspaceId == null) {
    workspaceId = await provisionWorkspaceForBinding(binding.agentId, channel.projectId)
    storage.updateBinding(binding.id, { workspaceId })
  }
  storage.updateBinding(binding.id, { status: 'active' })
  const chatId = await startBindingChat(binding, RECOVERY_PROMPT, workspaceId, true)
  storage.updateBinding(binding.id, { activeChatId: chatId, status: 'active' })
}

// ---- Auto-compact ----

/**
 * Trigger a /compact command on an agent binding's chat to compress conversation history.
 * Used for providers that don't auto-compact (Claude, Codex).
 */
async function triggerAutoCompact(binding: AgentBinding): Promise<void> {
  const storage = _storage
  if (!storage) return
  if (binding.activeChatId == null || binding.projectId == null) return

  const agent = storage.getAgent(binding.agentId)
  if (!agent) return

  const messages: UIMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: '/compact' }],
    },
  ]

  try {
    const ctx = await startChat({
      chatId: binding.activeChatId,
      messages,
      providerId: agent.provider,
      modelId: agent.model,
      modeId: agent.permissionMode || undefined,
      workspaceId: binding.workspaceId ?? undefined,
      skipSnapshot: true,
      env: resolveAgentEnv(agent),
      agentContext: { agentId: agent.id, projectId: binding.projectId },
    })

    const reader = ctx.preparedParts.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    await ctx.persistDone
    ctx.finish()

    console.log(`[Orchestrator] auto-compact completed for binding ${binding.id}`)

    const channelId = Number(binding.scopeKey)
    if (Number.isFinite(channelId)) {
      const sysMsg = storage.createMessage({
        channelId,
        senderType: 'system',
        senderName: 'system',
        content: `${agent.name} conversation history compacted automatically (context was running low).`,
      })
      emitChannelEvent(channelId, { type: 'channel_message', data: sysMsg })
    }
  } catch (err) {
    console.error(`[Orchestrator] triggerAutoCompact failed for binding ${binding.id}:`, err)
  }
}

// ---- Project-level task dispatch (local Linear) ----

/**
 * Look up the (agent × task) execution binding, creating it on first dispatch.
 * Unlike channel bindings, each task gets its OWN worktree (independent
 * execution agent — no shared workspace), so the binding pins its own
 * workspace_id rather than reusing the agent's per-project one.
 */
function ensureTaskBinding(
  storage: Storage,
  taskId: number,
  taskNumber: number,
  projectId: number,
  agentId: number,
  workspaceId: number | null,
  teamLabel: string | null,
): AgentBinding {
  // agent_session_id is the inbox routing key (unique per binding);
  // scopeDisplayName is the peer-facing handle suffix (`name@task-N`).
  const sessionKey = `task-${taskId}-${agentId}`
  const existing = storage.getBindingByScope('task', String(taskId), agentId)
  if (existing) {
    storage.updateBinding(existing.id, {
      workspaceId: existing.workspaceId ?? workspaceId ?? undefined,
      teamLabel: teamLabel ?? undefined,
      agentSessionId: sessionKey,
    })
    return storage.getBinding(existing.id) ?? existing
  }
  return storage.upsertBinding({
    agentId,
    scopeKind: 'task',
    scopeKey: String(taskId),
    scopeDisplayName: `task-${taskNumber}`,
    channelKind: 'channel',
    projectId,
    workspaceId,
    status: 'offline',
    agentSessionId: sessionKey,
    teamLabel: teamLabel ?? undefined,
  })
}

/**
 * Dispatch a project-level task to its assigned agent: provision a dedicated
 * per-task worktree, create a task-scoped binding, flip the task to
 * in_progress, and start the agent working on it. Progress narration into the
 * task activity feed arrives with the agent task tools (P4); for now the feed
 * records the dispatch + status events and the agent runs in its worktree.
 */
export async function dispatchProjectTask(taskId: number, assignedAgentId: number): Promise<void> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  const task = storage.taskGet(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  const project = storage.getProject(task.projectId)
  if (!project) throw new Error(`Project ${task.projectId} not found`)
  const agent = storage.getAgent(assignedAgentId)
  if (!agent) throw new Error(`Agent ${assignedAgentId} not found`)

  // Per-task worktree — independent execution agent, no shared workspace.
  // SDD child (§7 ④): cut a change-scoped branch `operon/task-<N>` off the
  // PARENT change branch, so siblings each own one branch (single-writer, §5.4)
  // and the branch belongs to the change, not the agent.
  const sddParent =
    task.sddManaged && task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  // An SDD parent already owns its change-branch worktree from promote
  // (`operon/task-<N>` + workspace, where spec/plan/acceptance live). A
  // small-change parent must execute THERE, not on a divergent `operon/<agent>/…`
  // branch — otherwise its code never lands on the change branch. Reuse it.
  const existingParentWorkspace =
    task.sddManaged && task.parentTaskId == null && task.workspaceId != null
      ? storage.getWorkspace(task.workspaceId)
      : null
  const workspace = existingParentWorkspace
    ? existingParentWorkspace
    : sddParent
      ? await provisionAgentWorkspace(assignedAgentId, task.projectId, {
          workspaceName: `${agent.name} · task #${task.number}`,
          branchName: changeBranchName(task.number),
          baseBranch: sddParent.branchName ?? undefined,
          worktreeName: `task-${task.number}`,
        })
      : await provisionAgentWorkspace(assignedAgentId, task.projectId, {
          suffix: `task-${task.number}`,
          workspaceName: `${agent.name} · task #${task.number}`,
        })

  // A team on the task groups its execution agent with peers working sibling
  // tasks (same team_id) for private inbox coordination. The binding's
  // team_label carries the team id so peer scoping stays an exact-match.
  const teamLabel = task.teamId != null ? `team-${task.teamId}` : null

  const binding = ensureTaskBinding(
    storage,
    taskId,
    task.number,
    task.projectId,
    assignedAgentId,
    workspace.id,
    teamLabel,
  )

  storage.taskUpdate(
    taskId,
    {
      status: 'in_progress',
      assignedAgentId,
      branchName: workspace.branchName,
      workspaceId: workspace.id,
      bindingId: binding.id,
    },
    { type: 'agent', id: assignedAgentId, name: agent.name },
  )
  storage.taskAppendActivity(taskId, {
    kind: 'dispatch',
    actorType: 'system',
    actorName: 'system',
    body: `Dispatched to ${agent.name}`,
    meta: { agentId: assignedAgentId, branch: workspace.branchName },
  })
  broadcastTask(storage, taskId)

  const sddChildPrompt = sddParent
    ? `\nThis is a spec-driven subtask of #${sddParent.number}` +
      (task.planAnchor ? ` (plan item ${task.planAnchor})` : '') +
      `. Your branch was cut from the parent change branch. Before coding, call ` +
      `get_project_task(task: ${task.number}) to read the parent spec/plan and the acceptance ` +
      `criteria you own${task.claimedAcs?.length ? ` (${task.claimedAcs.join(', ')})` : ''}; ` +
      `implement exactly your plan item, nothing outside it. To pass review (Gate-2) the ` +
      `subtask must own ≥1 AC. Expect an independent verifier to check those AC against your ` +
      `code afterwards — leave the change in a state where each one can actually be demonstrated.\n`
    : ''
  // SDD children already get a forced pre-read via sddChildPrompt; every other
  // task needs its own, because a comment left BEFORE dispatch lives only in the
  // activity feed (never inlined into this prompt) and is only guaranteed to be
  // seen if the agent reads the task first. get_project_task always renders `## Activity`.
  const readFirstPrompt = sddParent
    ? ''
    : `\nBefore you start coding, call get_project_task(task: ${task.number}) to read the full ` +
      `task — its description and the discussion/comments left before dispatch may carry ` +
      `requirements not repeated here. Don't begin until you've read it.\n`
  const taskPrompt =
    `You've been assigned task #${task.number}: ${task.title}\n` +
    (task.description ? `\n${task.description}\n` : '') +
    sddChildPrompt +
    readFirstPrompt +
    `\nYou are working on branch \`${workspace.branchName}\` in a dedicated worktree — ` +
    `this is your isolated workspace for this task. Implement it here.\n\n` +
    `Report progress with comment_project_task(task: ${task.number}, body: "...") as you go — ` +
    `when you start, hit a milestone, finish, or get blocked. When your work is ready for ` +
    `human review, call update_project_task(task: ${task.number}, status: "in_review"). ` +
    `Use get_project_task(task: ${task.number}) anytime to re-read the spec and discussion.`

  await deliverToBinding(
    storage,
    {
      binding,
      injectNotification: () => taskPrompt,
      wakePrompt: taskPrompt,
      ensureWorkspace: () => Promise.resolve(workspace.id),
      startChat: (prompt, workspaceId) => startBindingChat(binding, prompt, workspaceId, false),
    },
    { logTag: 'TaskDispatch', debounceMs: DEBOUNCE_MS },
  )
}

/**
 * Auto-start execution for a task that just became runnable — the analog of
 * clicking Dispatch, triggered whenever a task transitions into `in_progress`
 * with an assignee (board edit, dispatch_project_task, update_project_task). Without this, setting
 * a task to in_progress only writes DB state and no agent ever runs.
 *
 * Idempotent and guarded:
 *  - skips unless assigned and `in_progress`
 *  - skips a decomposed SDD parent (it coordinates; its children get dispatched)
 *  - skips if a live execution session already exists for the task
 * Errors are logged, never thrown — callers fire-and-forget.
 */
export async function maybeAutoDispatchTask(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.assignedAgentId == null || task.status !== 'in_progress') return
  // A decomposed SDD parent is a coordinator — its children execute, not it.
  if (task.sddManaged && task.parentTaskId == null && storage.taskListChildren(task.id).length > 0) {
    return
  }
  // Already running? A live task binding (active/idle with a chat) means an
  // execution session exists — don't start a second one.
  const existing = storage.getBindingByScope('task', String(taskId), task.assignedAgentId)
  if (existing?.activeChatId != null && (existing.status === 'active' || existing.status === 'idle')) {
    return
  }
  try {
    await dispatchProjectTask(taskId, task.assignedAgentId)
  } catch (err) {
    console.error(`[AutoDispatch] task ${taskId} auto-start failed:`, err)
  }
}

/**
 * Validate an SDD parent for the human Done path. Approves acceptance (moving a
 * change to done IS the human acceptance approval, mirroring how Dispatch
 * approves spec/plan) and sediments the spec delta onto the change branch. The
 * caller marks the parent done only after that change branch successfully
 * merges to the default branch. Acceptance is a natural-language verification
 * summary for the human reviewer — nothing is executed here; actual
 * verification happens in review (human or an agent working the checklist).
 *
 * Returns a structured result so HTTP can surface a 409 without throwing.
 *
 * Blocks (ok:false) when acceptance isn't written or a gate is unmet (e.g. a
 * child still open). The parent stays put; a human resolves it and the next
 * done attempt retries.
 */
export async function attemptFinalizeSddParent(
  parentId: number,
  actor: ArtifactActor,
): Promise<{ ok: true } | { ok: false; reason: string; gateDetail?: GateBlock }> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const parent = storage.taskGet(parentId)
  if (!parent || !parent.sddManaged || parent.parentTaskId != null) {
    return { ok: false, reason: 'not an SDD parent' }
  }
  if (parent.status === 'done') return { ok: true }

  // Gate-3 needs acceptance written + approved. Acceptance is the verifier's
  // report, so a missing one means nobody verified this change — allowed (a
  // verifier is opt-in), but it must not look the same afterwards as a verified
  // sign-off. Record the fact on the change branch instead of blocking: the file
  // itself says no verification ran, so `git log`/review shows how it was signed.
  let acc = storage.taskArtifactGet(parent.id, 'acceptance')
  if (!acc) {
    const stamp = `Signed off by ${actor.name} without running a verifier.`
    try {
      acc = await writeArtifact(storage, {
        taskId: parent.id,
        kind: 'acceptance',
        content:
          `# Acceptance — #${parent.number}\n\n` +
          `**No verification was run.** ${stamp} No acceptance criterion was independently\n` +
          `checked, and this file records that rather than any evidence.\n\n` +
          `To verify instead: move the change back to In Review and run a verifier.\n`,
        caller: actor,
      })
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'could not record unverified sign-off',
      }
    }
    storage.taskAppendActivity(parent.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: 'Signed off without verification — acceptance records that no verifier ran.',
      meta: { unverified: true },
    })
  }
  if (acc.status !== 'approved') {
    try {
      await approveArtifact(storage, { taskId: parent.id, kind: 'acceptance', approver: actor })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'approve acceptance failed' }
    }
  }

  // Gate-3: spec + acceptance approved + every child done/cancelled.
  await detectAndApplyDrift(storage, parent)
  try {
    assertGateOrThrow(storage, parent, 'done')
  } catch (err) {
    if (err instanceof GateError) return { ok: false, reason: err.message, gateDetail: err.detail }
    return { ok: false, reason: err instanceof Error ? err.message : 'gate check failed' }
  }

  // All gates clear → sediment the delta into the living spec on the change branch.
  // The caller marks the task done only after the change branch has merged to main.
  if (storage.taskArtifactGet(parent.id, 'spec_delta')) {
    try {
      const res = await sedimentChange(storage, parent.id, actor, { apply: true })
      if (res.conflicts.length > 0) {
        const details = res.conflicts.map((c) => `${c.id}: ${c.detail}`).join('; ')
        storage.taskAppendActivity(parent.id, {
          kind: 'system',
          actorType: 'system',
          actorName: 'system',
          body: `Sediment blocked for ${res.capability} — ${res.conflicts.length} semantic conflict(s).`,
          meta: { capability: res.capability, conflicts: res.conflicts },
        })
        broadcastTask(storage, parent.id)
        return {
          ok: false,
          reason: `sediment blocked for ${res.capability}: ${details || `${res.conflicts.length} semantic conflict(s)`}`,
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      storage.taskAppendActivity(parent.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'system',
        body: `Sediment failed — ${reason}`,
        meta: { error: reason },
      })
      broadcastTask(storage, parent.id)
      return { ok: false, reason: `sediment failed: ${reason}` }
    }
  }
  return { ok: true }
}

/**
 * A task entering in_review is a review state only. It intentionally does not
 * merge anything: the human reviewer marks the task done after reviewing, and
 * that done action performs the merge.
 *
 * Best-effort: errors are logged/recorded, never thrown — callers fire-and-forget.
 */
export async function maybeAutoIntegrate(
  taskId: number,
  toStatus: TaskStatus,
  _actor: ArtifactActor,
): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || !task.sddManaged || task.parentTaskId == null || toStatus !== 'in_review') return
  storage.taskAppendActivity(taskId, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: 'Ready for human review. Mark Done after review to merge this subtask into its parent.',
    meta: {},
  })
  broadcastTask(storage, taskId)
}

/** Branch/worktree name for a parent change's throwaway verification checkout. */
function verifyBranchName(taskNumber: number): string {
  return `operon/verify-task-${taskNumber}`
}

/**
 * Run an independent verifier over a completed SDD parent change (§11.2⑦). Opt-in:
 * the human picks the agent at parent review time, or skips and signs off unverified.
 *
 * Deliberately NOT `dispatchProjectTask`: that function forces `in_progress`,
 * overwrites `assignedAgentId`/`bindingId`, and tells the agent to implement. A
 * verifier must leave all three alone — the parent stays `in_review` and keeps
 * pointing at its implementer, so this only adds a second binding on the task.
 *
 * The verifier gets its own worktree cut from the change branch, not the change
 * branch worktree itself: "you are read-only" is not enforceable against an LLM,
 * and anything it wrote there would ride along into main. Its findings still land
 * on the change branch, because `write_artifact` writes to `task.workspaceId`
 * (the parent's worktree) regardless of where the caller is running — so the
 * report is durable while stray edits are thrown away with the checkout.
 *
 * The branch name is stable per task, so re-running a verifier reuses the same
 * worktree instead of piling up new ones.
 */
export async function dispatchVerifier(taskId: number, verifierAgentId: number): Promise<void> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  const task = storage.taskGet(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (!task.sddManaged || task.parentTaskId != null) {
    throw new Error(`Task #${task.number} is not an SDD parent change`)
  }
  if (task.status !== 'in_review') {
    throw new Error(
      `Task #${task.number} is ${task.status} — a verifier only runs on a change that is in review`,
    )
  }
  if (task.branchName == null) {
    throw new Error(`Task #${task.number} has no change branch to verify`)
  }
  const agent = storage.getAgent(verifierAgentId)
  if (!agent) throw new Error(`Agent ${verifierAgentId} not found`)
  const project = storage.getProject(task.projectId)
  if (!project) throw new Error(`Project ${task.projectId} not found`)

  // Re-cut the checkout from scratch every run. The branch name is stable, and
  // provisionAgentWorkspace would happily reuse an existing branch — which after a
  // FAIL → fix → re-verify round trip still points at the OLD change-branch tip,
  // so the verifier would review code that has since been rewritten. Dropping the
  // worktree and the branch first is the only way the next checkout sees HEAD.
  await cleanupVerifyWorktrees(taskId)
  await deleteLocalBranch(project.rootPath, verifyBranchName(task.number))

  const workspace = await provisionAgentWorkspace(verifierAgentId, task.projectId, {
    workspaceName: `${agent.name} · verify #${task.number}`,
    branchName: verifyBranchName(task.number),
    baseBranch: task.branchName,
    worktreeName: `verify-task-${task.number}`,
  })

  // No team label: a verifier reports to the human, not to the implementers.
  const binding = ensureTaskBinding(
    storage,
    taskId,
    task.number,
    task.projectId,
    verifierAgentId,
    workspace.id,
    null,
  )

  storage.taskAppendActivity(taskId, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: `Verification started by ${agent.name} on \`${workspace.branchName}\``,
    meta: { verifierAgentId, branch: workspace.branchName },
  })
  broadcastTask(storage, taskId)

  const implementer =
    task.assignedAgentId != null && task.assignedAgentId !== verifierAgentId
      ? storage.getAgent(task.assignedAgentId)?.name
      : null
  const verifyPrompt =
    `You are the independent verifier for spec-driven change #${task.number}: ${task.title}\n\n` +
    `You did not implement this change${implementer ? ` — ${implementer} did` : ''}. Do not take ` +
    `the implementer's reports at face value; check the code and the diff yourself.\n\n` +
    `Start with get_project_task(task: ${task.number}) — it gives you the spec (with its ` +
    `\`{#AC-n}\` scenarios), the plan, and the full activity history.\n\n` +
    `You are in a throwaway worktree on branch \`${workspace.branchName}\`, cut from the change ` +
    `branch \`${task.branchName}\`, which holds the complete merged change. Inspect it: read the ` +
    `diff against the default branch, read the code, and run whatever each acceptance criterion ` +
    `actually needs.\n\n` +
    `Verify EVERY \`{#AC-n}\` the spec defines, one at a time. For each, record what you did, what ` +
    `you observed, and PASS or FAIL. A check you did not actually run is not a PASS. Also look for ` +
    `requirements that were missed, work that went beyond the spec, and requirements that were ` +
    `misread.\n\n` +
    `When you're done, file your report with write_artifact(task: ${task.number}, ` +
    `kind: "acceptance", content: "...") — one section per AC with the evidence, then an overall ` +
    `verdict. That file is what the human signs off on, and it lands on the change branch (not in ` +
    `your worktree). Then post a one-paragraph summary with comment_project_task(task: ` +
    `${task.number}, body: "...").\n\n` +
    `Constraints: do not modify code — your worktree is discarded, so edits there are lost and ` +
    `pointless. Do not change the task status and do not mark anything done. If something FAILs, ` +
    `report it and stop; the human decides what happens next.`

  await deliverToBinding(
    storage,
    {
      binding,
      injectNotification: () => verifyPrompt,
      wakePrompt: verifyPrompt,
      ensureWorkspace: () => Promise.resolve(workspace.id),
      startChat: (prompt, workspaceId) => startBindingChat(binding, prompt, workspaceId, false),
    },
    { logTag: 'TaskVerify', debounceMs: DEBOUNCE_MS },
  )
}

/**
 * Remove the throwaway verification worktrees on a task — any binding whose
 * workspace isn't the task's own. Called when the change is signed off; by then
 * the verifier's report has long since landed on the change branch.
 *
 * Must run BEFORE cleanupTaskWorktree, which nulls `task.workspaceId` (the very
 * field that distinguishes the task's own workspace from a verifier's).
 * Best-effort: failures are logged, never thrown.
 */
async function cleanupVerifyWorktrees(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task) return
  const project = storage.getProject(task.projectId)
  if (!project) return
  for (const binding of storage.listBindingsForScope('task', String(taskId))) {
    if (binding.workspaceId == null || binding.workspaceId === task.workspaceId) continue
    const ws = storage.getWorkspace(binding.workspaceId)
    if (!ws) continue
    try {
      await worktreeRemove(project.rootPath, ws.worktreePath, true)
    } catch (err) {
      console.warn(`[Cleanup] verify worktree remove failed for task ${taskId}:`, err)
    }
    storage.deleteWorkspace(ws.id)
    storage.updateBinding(binding.id, { workspaceId: null })
  }
}

type CompletionResult = { ok: true } | { ok: false; reason: string; gateDetail?: GateBlock }

function localBranchName(ref: string | null): string | null {
  if (!ref) return null
  return ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref
}

function isNothingToCommit(err: unknown): boolean {
  return /nothing to commit|no changes added to commit|working tree clean/i.test(
    err instanceof Error ? err.message : String(err),
  )
}

async function commitOutstandingTaskWork(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.workspaceId == null) return
  const ws = storage.getWorkspace(task.workspaceId)
  if (!ws) return
  try {
    await commit(ws.worktreePath, `task #${task.number}: finalize before merge`, {
      includeUnstaged: true,
    })
  } catch (err) {
    if (!isNothingToCommit(err)) throw err
  }
}

async function mergeTaskBranchToDefault(taskId: number, actor: ArtifactActor): Promise<CompletionResult> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const task = storage.taskGet(taskId)
  if (!task) return { ok: false, reason: `Task ${taskId} not found` }
  if (!task.branchName || task.workspaceId == null) return { ok: true }
  const project = storage.getProject(task.projectId)
  if (!project) return { ok: false, reason: `Project ${task.projectId} not found` }

  try {
    await commitOutstandingTaskWork(taskId)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'commit before merge failed' }
  }

  const status = await getStatus(project.rootPath)
  const base = await getDefaultBaseBranch(project.rootPath)
  const expected = localBranchName(base)
  if (expected && status.current !== expected) {
    return {
      ok: false,
      reason: `main worktree is on ${status.current ?? '(detached)'}, expected ${expected}`,
    }
  }
  if (status.files.length > 0) {
    return {
      ok: false,
      reason: `main worktree has uncommitted changes; merge ${task.branchName} manually after cleaning it`,
    }
  }

  try {
    await mergeBranch(
      project.rootPath,
      task.branchName,
      `Merge task #${task.number}: ${task.title}`,
    )
    storage.taskAppendActivity(task.id, {
      kind: 'system',
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      body: `Merged \`${task.branchName}\` into ${expected ?? status.current ?? 'main'}`,
      meta: { branch: task.branchName, target: expected ?? status.current },
    })
    broadcastTask(storage, task.id)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'merge to main failed' }
  }
}

/**
 * Human "Done" path after review. The task is marked done only after the relevant
 * merge succeeds: SDD children merge into their parent change branch; ordinary
 * tasks and SDD parents merge their task branch into the default branch.
 */
export async function completeTaskAfterHumanReview(
  taskId: number,
  actor: ArtifactActor,
): Promise<CompletionResult> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const task = storage.taskGet(taskId)
  if (!task) return { ok: false, reason: `Task ${taskId} not found` }

  if (task.sddManaged && task.parentTaskId != null) {
    if (task.status !== 'in_review') {
      return { ok: false, reason: 'subtask must be In Review before it can be marked Done' }
    }
    try {
      await mergeChildIntoParent(storage, taskId, actor)
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'merge into parent failed' }
    }
    storage.taskUpdate(
      taskId,
      { status: 'done' },
      { type: actor.type, id: actor.id ?? undefined, name: actor.name },
    )
    broadcastTask(storage, taskId)
    await cleanupTaskWorktree(taskId)

    const siblings = storage.taskListChildren(task.parentTaskId)
    if (siblings.every((s) => s.status === 'done' || s.status === 'cancelled')) {
      // Every subtask is merged into the parent change branch, so the parent now
      // holds the complete change: move it to in_review, which for a parent means
      // "ready to be verified and signed", not "an agent is still working". The
      // human either runs a verifier (POST /tasks/:id/verify) or marks Done.
      const parent = storage.taskGet(task.parentTaskId)
      if (parent && parent.status !== 'in_review' && parent.status !== 'done') {
        storage.taskUpdate(
          task.parentTaskId,
          { status: 'in_review' },
          { type: 'system', name: 'system' },
        )
      }
      storage.taskAppendActivity(task.parentTaskId, {
        kind: 'system',
        actorType: 'system',
        actorName: 'system',
        body: 'All subtasks are merged into the change branch. Run a verifier, or mark Done to sign off unverified.',
        meta: {},
      })
      broadcastTask(storage, task.parentTaskId)
    } else {
      // This subtask's work is now merged into the parent change branch, which may
      // release the next wave: their branches get cut from the parent HERE, so they
      // actually see what just landed. Best-effort — a dispatch failure must not
      // undo the Done we already committed.
      const parent = storage.taskGet(task.parentTaskId)
      if (parent) {
        try {
          const ready = await nextDispatchableChildren(storage, parent)
          for (const next of ready) {
            if (next.assignedAgentId == null) continue
            await dispatchProjectTask(next.id, next.assignedAgentId)
            storage.taskAppendActivity(parent.id, {
              kind: 'system',
              actorType: 'system',
              actorName: 'system',
              body: `Started queued subtask #${next.number}${next.planAnchor ? ` (${next.planAnchor})` : ''} — its wave is now unblocked.`,
              meta: { childTaskId: next.id },
            })
          }
          if (ready.length > 0) broadcastTask(storage, parent.id)
        } catch (err) {
          console.error(`[SDD] failed to start next wave for parent ${parent.id}:`, err)
        }
      }
    }
    return { ok: true }
  }

  if (task.sddManaged && task.parentTaskId == null) {
    const finalized = await attemptFinalizeSddParent(taskId, actor)
    if (!finalized.ok) return finalized
  }

  const merged = await mergeTaskBranchToDefault(taskId, actor)
  if (!merged.ok) return merged

  storage.taskUpdate(
    taskId,
    { status: 'done' },
    { type: actor.type, id: actor.id ?? undefined, name: actor.name },
  )
  broadcastTask(storage, taskId)
  // Order matters: this reads task.workspaceId, which cleanupTaskWorktree nulls.
  await cleanupVerifyWorktrees(taskId)
  await cleanupTaskWorktree(taskId)
  return { ok: true }
}

/**
 * Reclaim a finished task's worktree + workspace row. Removes the git worktree
 * DIRECTORY only — the branch is kept (its commits live on and reach main via the
 * change merge). Drops the workspace row and clears the now-dangling pointers on
 * the task + its binding so a later re-dispatch re-provisions cleanly. Best-effort:
 * failures are logged, never thrown.
 */
export async function cleanupTaskWorktree(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.workspaceId == null) return
  const staleWsId = task.workspaceId
  const ws = storage.getWorkspace(staleWsId)
  const project = storage.getProject(task.projectId)
  if (ws && project) {
    try {
      await worktreeRemove(project.rootPath, ws.worktreePath, true)
    } catch (err) {
      console.warn(`[Cleanup] worktree remove failed for task ${taskId}:`, err)
    }
    storage.deleteWorkspace(ws.id)
  }
  storage.taskUpdate(taskId, { workspaceId: null }, { type: 'system', name: 'system' })
  if (task.assignedAgentId != null) {
    const binding = storage.getBindingByScope('task', String(taskId), task.assignedAgentId)
    if (binding && binding.workspaceId === staleWsId) {
      storage.updateBinding(binding.id, { workspaceId: null })
    }
  }
  broadcastTask(storage, taskId)
}

/**
 * Wake an idle/offline task binding to deliver an inbox notification — the
 * local analog of Linear's "post a comment to resurrect the session". Reuses
 * deliverToBinding: starts a fresh chat with the notification so the agent
 * reads its inbox via inbox_check. Returns false if it couldn't be woken.
 */
export async function wakeTaskBinding(bindingId: number, notification: string): Promise<boolean> {
  const storage = _storage
  if (!storage) return false
  const binding = storage.getBinding(bindingId)
  if (!binding || binding.scopeKind !== 'task') return false
  try {
    await deliverToBinding(
      storage,
      {
        binding,
        injectNotification: () => notification,
        wakePrompt: notification,
        ensureWorkspace: () => Promise.resolve(binding.workspaceId ?? null),
        startChat: (prompt, workspaceId) => startBindingChat(binding, prompt, workspaceId, false),
      },
      { logTag: 'TaskInbox', debounceMs: DEBOUNCE_MS },
    )
    return true
  } catch (err) {
    console.warn(`[TaskInbox] wakeTaskBinding failed for binding=${bindingId}:`, err)
    return false
  }
}

/**
 * Task bindings have no unread re-wake loop — a finished task turn simply
 * settles idle (so the assignee's live dot reflects it). Modeled as a
 * degenerate driver adapter: getUnreadCount is always 0, so handleBindingFinish
 * takes the idle branch and onIdle emits the status event.
 */
const taskFinishAdapter: BindingPlatformAdapter = {
  scopeKinds: new Set(['task']),
  logTag: 'TaskInbox',
  buildInjectNotification: () => '',
  ensureWorkspace: (binding) => Promise.resolve(binding.workspaceId ?? null),
  startChat: () => {
    throw new Error('task finish never re-wakes')
  },
  getUnreadCount: () => 0,
  onBreakerTrip: () => {},
  onIdle: (binding) => {
    if (binding.projectId != null) {
      emitProjectEvent(binding.projectId, {
        type: 'agent_status',
        agentId: binding.agentId,
        projectId: binding.projectId,
        status: 'idle',
      })
    }
  },
}

// ---- Finish handler ----

/**
 * Built-in channel ('app') platform adapter for the shared binding driver.
 * Unread is the channel's per-agent unread queue; re-wake resumes the channel
 * session; a tripped breaker posts a system message; idle emits agent_status.
 */
const channelAdapter: BindingPlatformAdapter = {
  scopeKinds: new Set(['app']),
  logTag: 'Orchestrator',
  buildInjectNotification: (binding, count) => {
    const name = _storage?.getChannel(Number(binding.scopeKey))?.name ?? binding.scopeKey
    return (
      `[System notification: You have ${count} new message(s) in #${name}. ` +
      `Call check_messages to read them when you're ready.]`
    )
  },
  ensureWorkspace: (binding) => {
    const projectId = binding.projectId
    if (projectId == null) return Promise.resolve(null)
    return provisionWorkspaceForBinding(binding.agentId, projectId)
  },
  startChat: (binding, workspaceId) => {
    const name = _storage?.getChannel(Number(binding.scopeKey))?.name ?? binding.scopeKey
    return startBindingChat(binding, buildWakeUpPrompt(name), workspaceId, false)
  },
  getUnreadCount: (binding) =>
    _storage?.getUnreadChannelMessages(binding.agentId, Number(binding.scopeKey)).length ?? 0,
  onBreakerTrip: (binding, unreadCount) => {
    const storage = _storage
    if (!storage) return
    const channelId = Number(binding.scopeKey)
    const agent = storage.getAgent(binding.agentId)
    const agentName = agent?.name ?? `Agent ${binding.agentId}`
    const sysMsg = storage.createMessage({
      channelId,
      senderType: 'system',
      senderName: 'system',
      content:
        `${agentName} failed to respond after ${MAX_IDLE_RETRIES} attempts ` +
        `(${unreadCount} unread). Likely a provider error — check the agent's model/provider configuration.`,
    })
    emitChannelEvent(channelId, { type: 'channel_message', data: sysMsg })
  },
  onIdle: (binding) => {
    if (binding.projectId != null) {
      emitProjectEvent(binding.projectId, {
        type: 'agent_status',
        agentId: binding.agentId,
        projectId: binding.projectId,
        status: 'idle',
      })
    }
  },
}

/**
 * Called when an agent's chat stream ends (per binding). Thin wrapper over the
 * shared driver with the channel adapter — kept so drainAgentChat can trigger a
 * finish by binding id without knowing about adapters.
 */
export async function handleBindingFinish(bindingId: number): Promise<void> {
  if (!_storage) return
  await driverHandleFinish(_storage, channelAdapter, bindingId)
}

// Re-export so unchanged callers compile — first-startup prompt constant is
// referenced in agent-recovery.
export { FIRST_STARTUP_PROMPT }
