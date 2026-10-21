import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { UIMessage } from 'ai'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { ChannelMessage } from '../../types/channel.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import { emitChannelEvent, emitProjectEvent } from '../channel-bus.js'
import { startChat, startServerChat } from '../ai.js'
import {
  commit,
  getDefaultLocalBranch,
  getStatus,
  mergeBranch,
  worktreeAdd,
  worktreeRemove,
  excludeLocally,
  MergeConflictError,
  worktreeList,
} from '../git.js'
import { worktreePathFor, sanitizeSegment } from '../worktree-paths.js'
import { broadcastTask } from '../task-events.js'
import { SPEC_FILES, specDir } from '../spec/files.js'
import { specDesignChanged } from '../spec/spec-service.js'
import { recordDecisions } from '../spec/decisions.js'
import {
  isReviewedTicket,
  onTicketInReview,
  onTicketLanded,
  onTicketSentBack,
  onTicketTurnEnded,
} from '../spec/build-run.js'
import { SURFACE_PROMPT, observeTaskChatPart, taskHasSurfaces } from '../../gateway/surfaces/task-surface-bridge.js'
import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import { changeBranchName, mergeChildIntoParent, type ChangeActor } from '../spec/change-branch.js'
import type { Task, TaskStatus } from '../../types/task.js'
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

type Storage = ChannelStorageAdapter & ProjectStorageAdapter & AgentBindingStorageAdapter & TaskStorageAdapter & NotificationStorageAdapter

const DEBOUNCE_MS = 3000
/** Context usage threshold (0-1) above which auto-compact is triggered for providers that don't auto-compact */
const AUTO_COMPACT_THRESHOLD = 0.8
/** Providers that handle compaction internally and don't need orchestrator-triggered compact */
const SELF_COMPACTING_PROVIDERS = new Set(['opencode'])

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
 * naming — used by spec ticket dispatch to put a change-scoped branch
 * (`operon/task-<N>`) cut off the spec's change branch into a change-scoped
 * worktree, so the branch belongs to the change, not the agent.
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

  // Not the tracked .gitignore: editing it left every fresh worktree dirty, and
  // agents committed that line into their task's branch.
  await excludeLocally(worktreePath, '.agent-memory/')

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

  // The persona travels as session instructions, re-derived on EVERY start (not
  // just first startup) — providers bake instructions at session creation and
  // resume does not restore a previous value.
  let instructions = buildAgentSystemPrompt(agent)
  // A task that is visible on Linear / GitHub gets told how to talk there and
  // how code leaves the worktree (design.md §12).
  if (binding.scopeKind === 'task' && taskHasSurfaces(Number(binding.scopeKey))) {
    instructions += `\n\n${SURFACE_PROMPT}`
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
    ctx = await startServerChat({
      chatId: binding.activeChatId ?? undefined,
      messages,
      providerId: agent.provider,
      // An agent without a model (the hidden spec builders) runs on the provider's default.
      modelId: agent.model || undefined,
      modeId: agent.permissionMode || undefined,
      workspaceId: workspaceId ?? undefined,
      env: resolveAgentEnv(agent),
      instructions,
      agentContext: {
        agentId: agent.id,
        projectId: binding.projectId,
        // App-scoped bindings are channel sessions: scopeKey is the channel id.
        // Forwarded to taskboard so tools that need the source channel derive it here
        // instead of trusting a (frequently wrong) model-supplied id.
        channelId: binding.scopeKind === 'app' ? Number(binding.scopeKey) : undefined,
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
    // A spec ticket whose session cannot start would sit in "building" forever.
    if (binding.scopeKind === 'task') void onTicketTurnEnded(storage, Number(binding.scopeKey), errMsg).catch(() => {})
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
  drainAgentChat(ctx, binding)
  return ctx.chatId
}

function drainAgentChat(ctx: Awaited<ReturnType<typeof startServerChat>>, binding?: AgentBinding): void {
  console.log(`[Orchestrator] drainAgentChat: started for chatId=${ctx.chatId}`)
  // Task sessions mirror their stream to Linear / GitHub when the task has
  // surfaces (design.md §9). The bridge checks per part (memoized), because a
  // surface can attach after the session started — desktop dispatch first,
  // the Linear session only when someone delegates the published issue.
  const surfaceTaskId = binding?.scopeKind === 'task' ? Number(binding.scopeKey) : null
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
        if (surfaceTaskId != null && part && typeof part === 'object' && 'type' in part) {
          try {
            observeTaskChatPart(surfaceTaskId, ctx.chatId, part as unknown as RuntimeTextStreamPart)
          } catch (err) {
            console.warn('[Orchestrator] surface observer failed:', err instanceof Error ? err.message : err)
          }
        }
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

      // A spec ticket's turn that ended without handing the ticket in gets a reminder (or blocks it).
      if (surfaceTaskId != null) {
        void onTicketTurnEnded(storage, surfaceTaskId, errors.length > 0 ? errors.join('; ') : undefined).catch((err) =>
          console.error('[Orchestrator] spec ticket turn-end hook failed:', err),
        )
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
    if (surfaceTaskId != null && _storage) {
      void onTicketTurnEnded(_storage, surfaceTaskId, err instanceof Error ? err.message : String(err)).catch(() => {})
    }
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
      // An agent without a model (the hidden spec builders) runs on the provider's default.
      modelId: agent.model || undefined,
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
): AgentBinding {
  const sessionKey = `task-${taskId}-${agentId}`
  const existing = storage.getBindingByScope('task', String(taskId), agentId)
  if (existing) {
    storage.updateBinding(existing.id, {
      workspaceId: existing.workspaceId ?? workspaceId ?? undefined,
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
  })
}

/**
 * Dispatch a project-level task to its assigned agent: provision a dedicated
 * per-task worktree, create a task-scoped binding, flip the task to
 * in_progress, and start the agent working on it. Progress narration into the
 * task activity feed arrives with the agent task tools (P4); for now the feed
 * records the dispatch + status events and the agent runs in its worktree.
 */
/** Dispatch refused because tasks this one is blocked by are not done yet. */
export class TaskBlockedError extends Error {
  constructor(readonly blockers: Task[]) {
    super(`Blocked by ${blockers.map((b) => `#${b.number} (${b.status})`).join(', ')} — finish those first`)
  }
}

/** Dispatch refused because the spec's design changed after it was approved. */
export class SpecDesignChangedError extends Error {
  constructor(readonly specNumber: number) {
    super(`The design of spec #${specNumber} changed after it was approved — re-approve it before starting more tickets`)
  }
}

export async function dispatchProjectTask(taskId: number, assignedAgentId: number): Promise<void> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  const task = storage.taskGet(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  // A blocker builds what this task stands on; starting before it is done means
  // starting from a branch that does not have it yet.
  const blockers = (task.blockedBy ?? [])
    .map((id) => storage.taskGet(id))
    .filter((b): b is Task => b != null && b.status !== 'done' && b.status !== 'cancelled')
  if (blockers.length > 0) throw new TaskBlockedError(blockers)
  // A ticket builds the design that was signed; if design.md moved on since, the
  // user signs the new text before more work starts from it.
  if (task.parentTaskId != null && (await specDesignChanged(storage, task.parentTaskId))) {
    throw new SpecDesignChangedError(storage.taskGet(task.parentTaskId)?.number ?? task.parentTaskId)
  }
  const project = storage.getProject(task.projectId)
  if (!project) throw new Error(`Project ${task.projectId} not found`)
  const agent = storage.getAgent(assignedAgentId)
  if (!agent) throw new Error(`Agent ${assignedAgentId} not found`)

  // Per-task worktree — independent execution agent, no shared workspace. A
  // spec ticket cuts its own change-scoped branch `operon/task-<N>` off the
  // spec's change branch: the design lives there, and so does every ticket
  // merged before it.
  const parentTask = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  const specParent = parentTask?.specStage != null ? parentTask : null
  const workspace = specParent
    ? await provisionAgentWorkspace(assignedAgentId, task.projectId, {
        workspaceName: `${agent.name} · task #${task.number}`,
        branchName: changeBranchName(task.number),
        baseBranch: specParent.branchName ?? undefined,
        worktreeName: `task-${task.number}`,
      })
    : await provisionAgentWorkspace(assignedAgentId, task.projectId, {
        suffix: `task-${task.number}`,
        workspaceName: `${agent.name} · task #${task.number}`,
      })

  const binding = ensureTaskBinding(
    storage,
    taskId,
    task.number,
    task.projectId,
    assignedAgentId,
    workspace.id,
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
  // The first ticket under way puts the spec itself in progress.
  if (specParent && specParent.status === 'todo') {
    storage.taskUpdate(specParent.id, { status: 'in_progress' }, { type: 'system', name: 'system' })
    broadcastTask(storage, specParent.id)
  }

  // A spec ticket carries its acceptance and interfaces in the description; the
  // design it implements lives on the spec's change branch, which this branch
  // was cut from.
  const specTicketPrompt = specParent
    ? `\nThis is a ticket of spec #${specParent.number}. Your branch was cut from the spec's change ` +
      `branch, so the design is already in your worktree: read ` +
      `\`${specDir(specParent.number)}/${SPEC_FILES.design}\` (and \`${SPEC_FILES.grounding}\` next to it) ` +
      `before coding, then build exactly this ticket — nothing another ticket owns. If the design ` +
      `contradicts itself in a small way, decide, write "Ruling: …, because …" in your report and keep ` +
      `going; stop only for something destructive or irreversible. When you finish, commit your work on ` +
      `this branch (the ticket is merged from its commits, so uncommitted changes are lost), then post your report ` +
      `with comment_project_task: what you built, the commands you actually ran with their results, every ruling, ` +
      `and anything that departs from the design. Then move the ticket to in_review — a separate reviewer reads that ` +
      `report against your diff, and either merges the ticket or sends its points back to you here.\n`
    : ''
  // A ticket already gets its forced pre-read above; every other task needs its
  // own, because a comment left BEFORE dispatch lives only in the activity feed
  // (never inlined into this prompt) and is only guaranteed to be seen if the
  // agent reads the task first. get_project_task always renders `## Activity`.
  const readFirstPrompt = specParent
    ? ''
    : `\nBefore you start coding, call get_project_task(task: ${task.number}) to read the full ` +
      `task — its description and the discussion/comments left before dispatch may carry ` +
      `requirements not repeated here. Don't begin until you've read it.\n`
  const taskPrompt =
    `You've been assigned task #${task.number}: ${task.title}\n` +
    (task.description ? `\n${task.description}\n` : '') +
    specTicketPrompt +
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
 *  - skips a spec parent (it coordinates; its tickets get dispatched)
 *  - skips if a live execution session already exists for the task
 * Errors are logged, never thrown — callers fire-and-forget.
 */
export async function maybeAutoDispatchTask(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.assignedAgentId == null || task.status !== 'in_progress') return
  // A spec parent is a coordinator — its tickets execute, not it.
  if (task.specStage != null) return
  // Already running? A live task binding (active/idle with a chat) means an
  // execution session exists — don't start a second one. A binding without a
  // worktree is not one: Done removed it, and a reopened task needs it back.
  const existing = storage.getBindingByScope('task', String(taskId), task.assignedAgentId)
  if (
    existing?.activeChatId != null &&
    existing.workspaceId != null &&
    (existing.status === 'active' || existing.status === 'idle')
  ) {
    return
  }
  try {
    await dispatchProjectTask(taskId, task.assignedAgentId)
  } catch (err) {
    console.error(`[AutoDispatch] task ${taskId} auto-start failed:`, err)
  }
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
  _actor: ChangeActor,
): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.parentTaskId == null || toStatus !== 'in_review') return
  // A spec ticket is reviewed by an agent from another family, not by a person.
  if (isReviewedTicket(storage, taskId)) onTicketInReview(storage, taskId)
}

type CompletionResult = { ok: true } | { ok: false; reason: string }

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

async function mergeTaskBranchToDefault(taskId: number, actor: ChangeActor): Promise<CompletionResult> {
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
  const expected = await getDefaultLocalBranch(project.rootPath)
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
      meta: { event: 'branch.merged', branch: task.branchName, target: expected ?? status.current ?? 'main' },
    })
    broadcastTask(storage, task.id)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'merge to main failed' }
  }
}

/**
 * A ticket's branch conflicts with the change branch (another ticket touched the
 * same lines). Git cannot settle it, so the ticket goes back to its own agent —
 * it knows the code — to merge the change branch in, resolve, re-check and
 * return to review. Without an agent there is nobody to hand it to.
 */
async function handBackMergeConflict(task: Task, parent: Task, err: MergeConflictError): Promise<CompletionResult> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const files = err.files.length > 0 ? err.files.join(', ') : 'unknown files'
  const agent = task.assignedAgentId != null ? storage.getAgent(task.assignedAgentId) : null
  if (task.bindingId == null || !agent) {
    return {
      ok: false,
      reason: `Merging into ${parent.branchName} conflicts in ${files}, and no agent is assigned to resolve it — merge it by hand.`,
    }
  }
  storage.taskUpdate(task.id, { status: 'in_progress' }, { type: 'system', name: 'system' })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'system',
    body: `Merging into \`${parent.branchName}\` conflicted in ${files}. Sent back to ${agent.name} to resolve.`,
    meta: { event: 'merge.conflict', target: parent.branchName, files: err.files },
  })
  broadcastTask(storage, task.id)
  await wakeTaskBinding(
    task.bindingId,
    `Marking task #${task.number} done failed: merging your branch \`${task.branchName}\` into \`${parent.branchName}\` ` +
      `conflicts in ${files} — another ticket changed the same code. Merge \`${parent.branchName}\` into your branch, ` +
      `resolve the conflicts so both tickets' changes survive (never drop the other ticket's work), re-run the checks ` +
      `your acceptance criteria name, commit the merge, then call update_project_task(task: ${task.number}, status: "in_review").`,
  )
  return {
    ok: false,
    reason: `Merge conflict in ${files} — sent back to ${agent.name} to resolve. Mark it Done again once it is back in review.`,
  }
}

/**
 * Land a reviewed spec ticket: merge it into the spec's change branch, mark it
 * done, reclaim its worktree, and let the build stage start what it unblocked.
 * The ticket's review passing and a person marking it Done both end here. A
 * merge conflict sends it back to its own implementer (`handedBack`).
 */
export async function landSpecTicket(
  taskId: number,
  actor: ChangeActor,
): Promise<CompletionResult | { ok: false; reason: string; handedBack: true }> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const task = storage.taskGet(taskId)
  const parent = task?.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  if (!task || !parent || parent.specStage == null) return { ok: false, reason: `Task ${taskId} is not a spec ticket` }
  if (task.status !== 'in_review') return { ok: false, reason: 'subtask must be In Review before it can be marked Done' }
  try {
    await mergeChildIntoParent(storage, taskId, actor)
  } catch (err) {
    if (err instanceof MergeConflictError) {
      const handed = await handBackMergeConflict(task, parent, err)
      if (handed.ok || task.bindingId == null || task.assignedAgentId == null) return handed
      onTicketSentBack(storage, parent.id, taskId)
      return { ok: false, reason: handed.reason, handedBack: true }
    }
    return { ok: false, reason: err instanceof Error ? err.message : 'merge into parent failed' }
  }
  storage.taskUpdate(taskId, { status: 'done' }, { type: actor.type, id: actor.id ?? undefined, name: actor.name })
  broadcastTask(storage, taskId)
  await cleanupTaskWorktree(taskId)
  await onTicketLanded(storage, parent.id, taskId)
  return { ok: true }
}

/**
 * Human "Done" path after review. The task is marked done only after the relevant
 * merge succeeds: spec tickets merge into their spec's change branch; ordinary
 * tasks and spec parents merge their branch into the default branch.
 */
export async function completeTaskAfterHumanReview(
  taskId: number,
  actor: ChangeActor,
): Promise<CompletionResult> {
  const storage = _storage
  if (!storage) return { ok: false, reason: 'orchestrator not initialised' }
  const task = storage.taskGet(taskId)
  if (!task) return { ok: false, reason: `Task ${taskId} not found` }

  // A ticket of an OperonSpec merges into the spec's change branch; a person's
  // Done is the way past its automatic review.
  const changeParent = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  if (changeParent?.specStage != null) {
    const landed = await landSpecTicket(taskId, actor)
    return landed.ok ? landed : { ok: false, reason: landed.reason }
  }
  if (task.specStage != null) {
    const open = storage.taskListChildren(task.id).filter((c) => c.status !== 'done' && c.status !== 'cancelled')
    if (open.length > 0) {
      return { ok: false, reason: `Tickets still open: ${open.map((c) => `#${c.number}`).join(', ')}` }
    }
    // What the change leaves behind rides into the default branch with it.
    const ws = task.workspaceId != null ? storage.getWorkspace(task.workspaceId) : null
    if (ws) {
      try {
        await recordDecisions(storage, task, { taskId: task.id, taskNumber: task.number, worktreePath: ws.worktreePath })
      } catch (err) {
        if (err instanceof MergeConflictError) {
          return {
            ok: false,
            reason:
              `The default branch has changed since this spec branched, and merging it in conflicts in ${err.files.join(', ') || 'some files'}. ` +
              `Request changes asking for ${err.branch} to be merged in and the conflicts resolved — that is built and reviewed ` +
              `like any ticket — then sign off again.`,
          }
        }
        return { ok: false, reason: `Could not record the spec's decisions: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }

  const merged = await mergeTaskBranchToDefault(taskId, actor)
  if (!merged.ok) return merged
  // Gate 2 signed: the spec's change is in the default branch.
  if (task.specStage != null) storage.specRunUpdate(taskId, { stage: 'done', error: null })

  storage.taskUpdate(
    taskId,
    { status: 'done' },
    { type: actor.type, id: actor.id ?? undefined, name: actor.name },
  )
  broadcastTask(storage, taskId)
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
 * Wake an idle/offline task binding with a notification (e.g. a comment on its
 * task) — the local analog of Linear's "post a comment to resurrect the
 * session". Reuses deliverToBinding: injects into the running chat, or starts a
 * fresh one with the notification as the prompt. Returns false if it couldn't
 * be woken.
 */
/**
 * Pick an assigned task back up in its existing session — after an Operon
 * restart killed the turn, or when the agent stopped before the task was done.
 * The session keeps its history; the prompt only says where to restart from.
 */
export async function resumeProjectTask(taskId: number): Promise<boolean> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')
  const task = storage.taskGet(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (task.bindingId == null) throw new Error(`Task #${task.number} has never been dispatched`)
  const binding = storage.getBinding(task.bindingId)
  if (binding?.status === 'active') return false
  const woke = await wakeTaskBinding(
    task.bindingId,
    `Your work on task #${task.number} stopped before it was finished (Operon restarted or the last turn ended). ` +
      `Continue from the current state of your worktree — check \`git status\` and the task's activity first, ` +
      `don't redo what is already there.`,
  )
  if (woke) {
    storage.taskAppendActivity(taskId, {
      kind: 'system',
      actorType: 'human',
      actorName: 'You',
      body: 'Resumed the agent',
      meta: { event: 'task.resumed' },
    })
    broadcastTask(storage, taskId)
  }
  return woke
}

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
  // Task turns drain through here too; the channel adapter ignores task scope, so
  // without this a finished task binding stayed 'active' forever.
  const adapter = _storage.getBinding(bindingId)?.scopeKind === 'task' ? taskFinishAdapter : channelAdapter
  await driverHandleFinish(_storage, adapter, bindingId)
}

// Re-export so unchanged callers compile — first-startup prompt constant is
// referenced in agent-recovery.
export { FIRST_STARTUP_PROMPT }
