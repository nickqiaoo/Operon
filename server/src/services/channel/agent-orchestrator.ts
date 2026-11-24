import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { FileUIPart, UIMessage } from 'ai'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { ChannelMessage } from '../../types/channel.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { AgentMcpContext } from '../ai/types.js'
import type { Workspace } from '../../types/project.js'
import { emitProjectEvent, publishChannelMessage } from '../channel-bus.js'
import { abortChat, startChat, startServerChat } from '../ai.js'
import { resetBinding } from './binding-reset.js'
import {
  commit,
  getDefaultLocalBranch,
  getCurrentBranch,
  getStatus,
  mergeBranch,
  worktreeAdd,
  worktreeRemove,
  excludeLocally,
  MergeConflictError,
  worktreeList,
  worktreePrune,
  localBranchExists,
} from '../git.js'
import { worktreePathFor, sanitizeSegment } from '../worktree-paths.js'
import { broadcastTask } from '../task-events.js'
import { notifyTaskTurnFinished, setTaskSessionResolver, type TaskSessionRef } from '../notification-service.js'
import { SPEC_FILES, restoreSpecFiles, specDir, withSpecFilesArchived, type SpecLocation } from '../spec/files.js'
import { specDesignChanged } from '../spec/spec-service.js'
import { startIntegration, unreviewedFiles } from '../spec/review-run.js'
import { stopDesignRun } from '../spec/design-run.js'
import { RewindService } from '../rewind/index.js'
import {
  isReviewedTicket,
  onTicketInReview,
  onTicketLanded,
  onTicketSentBack,
  onTicketTurnEnded,
  recordTicketChat,
} from '../spec/build-run.js'
import { SURFACE_PROMPT, observeTaskChatPart, taskHasSurfaces } from '../../gateway/surfaces/task-surface-bridge.js'
import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import { changeBranchName, mergeChildIntoParent, type ChangeActor } from '../spec/change-branch.js'
import type { Task, TaskStatus, TaskWorkspaceMode } from '../../types/task.js'
import { deliverToBinding } from '../message-router.js'
import { activityAttachments, taskAttachmentFiles } from '../task-attachments.js'
import { waitForTaskTitle } from '../task-title.js'
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
  buildPeerFollowUpPrompt,
  buildRecoveryPrompt,
  buildThreadSessionPrompt,
  buildThreadStartPrompt,
  buildThreadWakePrompt,
  buildWakeUpPrompt,
  FIRST_STARTUP_PROMPT,
  type WakeMessages,
} from './agent-system-prompt.js'
import { formatChannelMessage } from '../agent-comm/channel-message-format.js'
import { markReadIn, streamOfBinding, streamTarget, unreadIn, type SessionStream } from './session-stream.js'
import { emitThreadUpdated, ensureChannelSession, onSessionInputChanged, registerThreadDelivery, routeThreadMessage } from './threads.js'
import { initChannelAttention } from './channel-attention.js'
import { getChatStorage } from '../ai/state.js'
import { subscribePendingInput } from '../ai/chat-pending-input.js'
import { resolveAgentEnv } from './agent-env.js'
import { channelAttachmentFiles, MAX_MESSAGE_IMAGES } from './channel-attachments.js'
import { assistantAgentMode } from '../agents/subagent-mode.js'
import {
  cancelPeerNudge,
  describeSenders,
  getFollowUps,
  MAX_AGENT_FOLLOW_UPS,
  planRewake,
  setFollowUps,
} from './peer-awareness.js'

type Storage = ChannelStorageAdapter & ProjectStorageAdapter & AgentBindingStorageAdapter & TaskStorageAdapter & NotificationStorageAdapter

const DEBOUNCE_MS = 3000
/** Context usage threshold (0-1) above which auto-compact is triggered for providers that don't auto-compact */
const AUTO_COMPACT_THRESHOLD = 0.8
/** Providers that handle compaction internally and don't need orchestrator-triggered compact */
const SELF_COMPACTING_PROVIDERS = new Set(['opencode'])

let _storage: Storage | null = null
let _stopWatchingTasks: (() => void) | null = null
let _stopWatchingPendingInput: (() => void) | null = null
/**
 * When each task binding's current turn started, for the turn-end notice. Only
 * turns the orchestrator starts are here: a message the user types into the
 * task's tab is their own conversation, announced (if at all) as a chat.
 */
const taskTurnStartedAt = new Map<number, number>()

// ---- Public helpers ----

/** App and task agents are owned by orchestration, not by the tabs viewing them. */
export function isAgentOwnedChat(chatId: number): boolean {
  if (!_storage) return false
  const binding = _storage.getBindingByActiveChatId(chatId)
  return binding != null && (binding.scopeKind === 'app' || binding.scopeKind === 'task' || binding.scopeKind === 'thread')
}

// ---- Public init ----

export function initOrchestrator(storage: Storage): void {
  _storage = storage
  _stopWatchingTasks?.()
  _stopWatchingTasks = storage.onTaskChange(onTaskChanged)
  // Repair existing Specs too; these agents are hidden from ordinary pickers.
  for (const binding of storage.listBindings({ scopeKind: 'task' })) {
    const task = storage.taskGet(Number(binding.scopeKey))
    if (task?.specStage != null && task.bindingId === binding.id) attachSpecCoordinator(task.id, binding.agentId)
  }
  registerBindingAdapter(channelAdapter)
  registerBindingAdapter(threadAdapter)
  registerBindingAdapter(taskFinishAdapter)
  initBindingFinishDispatch(storage)
  setTaskSessionResolver((taskId) => taskSessionOf(storage, taskId))
  // An approval or question a channel / thread session raises shows in the channel.
  _stopWatchingPendingInput?.()
  _stopWatchingPendingInput = subscribePendingInput((change) => onSessionInputChanged(storage, change.chatId))
  initChannelAttention(storage)
  registerThreadDelivery({
    toThreadSession: (binding) => deliverBinding(storage, threadAdapter, storage.getBinding(binding.id) ?? binding),
    toChannelSessions: (channelId, message) => deliverToChannelSessions(channelId, message),
    toChannelSession: (binding) => deliverBinding(storage, channelAdapter, storage.getBinding(binding.id) ?? binding),
  })
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
  return ensureChannelSession(storage, { id: channelId, name: channelName, projectId }, agentId)
}

// ---- Core routing ----

/**
 * Route a newly created channel message to the sessions it is for. Called
 * after every human message is persisted (agents' own posts are routed by the
 * workspace chat tools). A main-channel message goes to every member's channel
 * session; a thread reply to the thread's sessions (see threads.ts).
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
  if (message.threadRootId != null) {
    const channel = storage.getChannel(channelId)
    if (!channel) return
    await routeThreadMessage(storage, channel, message)
    return
  }
  await deliverToChannelSessions(channelId, message)
}

/** Deliver a message to every agent member's channel session. */
async function deliverToChannelSessions(channelId: number, message: ChannelMessage): Promise<void> {
  const storage = _storage
  if (!storage) return

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

    const binding = ensureChannelBinding(storage, channelId, channel.name, channel.projectId, agentId)
    // Don't echo back to the session that posted it
    if (message.senderBindingId != null ? message.senderBindingId === binding.id : message.senderType === 'agent' && message.senderId === agentId) continue
    // A human spoke: agent-only follow-ups start counting again from zero.
    if (message.senderType === 'human') setFollowUps(storage, binding.id, 0)

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
  // didn't pick it up yet. Task bindings don't count: their workspace belongs to
  // the task (its own throwaway worktree, or — in 'shared' mode — whichever
  // workspace the user ran it in, often main), never the agent's permanent one.
  // Reusing it put the agent's channel sessions straight into main.
  const peers = storage.listBindings({ agentId, projectId }).filter((b) => b.scopeKind !== 'task')
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
 * The permission mode a binding's session runs in. The agent's own setting
 * wins. Without one, a channel or thread session — which nobody is watching
 * turn by turn — runs in its provider's auto-approval tier: it goes ahead with
 * what looks safe and asks only about the rest, and that question shows up as
 * a card in the channel or thread. The provider's own default asks about nearly
 * everything, which left these sessions stuck. Task sessions keep the default.
 */
function bindingModeId(agent: { provider: string; permissionMode: string }, binding: AgentBinding): string | undefined {
  if (agent.permissionMode) return agent.permissionMode
  if (binding.scopeKind !== 'app' && binding.scopeKind !== 'thread') return undefined
  try {
    return assistantAgentMode(agent.provider)
  } catch {
    return undefined
  }
}

/**
 * Start a fresh chat for a per-channel app binding.
 * Returns the new chat id; caller (message-router) writes it back to the binding.
 */
/**
 * The agent context every turn of a binding's chat starts with. It decides the
 * session's MCP servers, so all turns of one chat must pass the same one.
 */
function bindingAgentContext(binding: AgentBinding): AgentMcpContext {
  // App bindings are channel sessions (scopeKey = channel id), thread bindings
  // thread sessions in a channel. The channel is forwarded to taskboard so tools
  // that need the source channel derive it here instead of trusting a
  // (frequently wrong) model-supplied id. Without it, chat-flow treats the chat
  // as a direct one and leaves out workspace_chat. The thread scopes
  // workspace_chat to that thread.
  const stream = _storage ? streamOfBinding(_storage, binding) : null
  return {
    agentId: binding.agentId,
    projectId: binding.projectId ?? undefined,
    channelId: stream?.channelId,
    threadRootId: stream?.kind === 'thread' ? stream.rootMessageId : undefined,
  }
}

/**
 * Post a system notice where a channel or thread session's people will see it
 * (its channel, or its thread). Task / IM bindings have nowhere to post.
 */
function postBindingNotice(storage: Storage, binding: AgentBinding, content: string): void {
  const stream = streamOfBinding(storage, binding)
  if (!stream) return
  const sysMsg = storage.createMessage({
    channelId: stream.channelId,
    threadRootId: stream.kind === 'thread' ? stream.rootMessageId : null,
    senderType: 'system',
    senderName: 'system',
    content,
  })
  publishChannelMessage(storage, sysMsg)
}

function bindingWhere(storage: Storage, stream: SessionStream): string {
  const name = storage.getChannel(stream.channelId)?.name ?? String(stream.channelId)
  return streamTarget(name, stream)
}

// ---- Wake-up delivery ----

/** Most recent unread messages a wake-up prompt carries; older ones are pointed to read_history. */
const WAKE_MAX_MESSAGES = 30
const WAKE_EXCERPT_MAX_CHARS = 4000

/**
 * The unread messages to hand over in a channel wake-up prompt. Starting the
 * turn with them is a delivery like check_messages (the agent reads them first
 * thing), so the cursor moves to `lastId` once the turn has started — not
 * before, so a failed start leaves them unread.
 */
function collectWakeMessages(
  storage: Storage,
  binding: AgentBinding,
  channelName: string,
): { messages: WakeMessages; lastId: number | null; files: FileUIPart[] } {
  const stream = streamOfBinding(storage, binding)
  const unread = stream ? unreadIn(storage, binding.agentId, stream) : []
  const shown = unread.slice(-WAKE_MAX_MESSAGES)
  const lines = shown.map((m) => {
    const body = m.content.length <= WAKE_EXCERPT_MAX_CHARS
      ? m.content
      : `${m.content.slice(0, WAKE_EXCERPT_MAX_CHARS)}… (truncated — read_history has the full message)`
    return formatChannelMessage(m, channelName, body)
  })
  return {
    messages: { lines, omitted: unread.length - shown.length },
    lastId: unread.length > 0 ? unread[unread.length - 1].id : null,
    files: wakeImages(shown),
  }
}

/**
 * The images on the messages a turn starts with, as file parts: the model sees
 * them directly. The most recent ones win when there are more than a turn takes;
 * the rest stay reachable through the paths in each message's text.
 */
function wakeImages(messages: ChannelMessage[]): FileUIPart[] {
  // The same image posted twice is the same bytes (content-addressed): send it once.
  return latestUniqueImages(channelAttachmentFiles(messages.flatMap((m) => m.attachments ?? [])))
}

function latestUniqueImages(files: FileUIPart[]): FileUIPart[] {
  const latest = new Map<string, FileUIPart>()
  for (const file of files) {
    latest.delete(file.url)
    latest.set(file.url, file)
  }
  return [...latest.values()].slice(-MAX_MESSAGE_IMAGES)
}

function markWakeDelivered(storage: Storage, binding: AgentBinding, lastId: number | null): void {
  if (lastId == null) return
  const stream = streamOfBinding(storage, binding)
  if (stream) markReadIn(storage, binding.agentId, stream, lastId)
}

/** Main-channel messages a thread session's first prompt shows from just before its root. */
const THREAD_CONTEXT_MESSAGES = 8

/**
 * Other running sessions of this agent in the same workspace — a thread session
 * shares its agent's workspace, so it is told who else may be changing files.
 */
function busySiblings(storage: Storage, binding: AgentBinding): string[] {
  if (binding.workspaceId == null) return []
  return storage
    .listBindings({ agentId: binding.agentId, status: 'active' })
    .filter((b) => b.id !== binding.id && b.workspaceId === binding.workspaceId)
    .map((b) => b.scopeKind === 'app'
      ? `your channel session in ${b.scopeDisplayName ?? 'a channel'}`
      : b.scopeKind === 'thread'
        ? `your thread session ${b.scopeDisplayName ?? ''}`.trim()
        : `your ${b.scopeKind} session ${b.scopeDisplayName ?? ''}`.trim())
}

/**
 * The prompt a thread session's turn starts with. Its first turn gets the
 * message it is under and the channel messages before it; later turns only
 * what is new in the thread.
 */
function buildThreadTurnPrompt(
  storage: Storage,
  binding: AgentBinding,
  stream: Extract<SessionStream, { kind: 'thread' }>,
): { prompt: string; lastId: number | null; files: FileUIPart[] } {
  const channelName = storage.getChannel(stream.channelId)?.name ?? String(stream.channelId)
  const target = streamTarget(channelName, stream)
  const wake = collectWakeMessages(storage, binding, channelName)
  const busy = busySiblings(storage, binding)
  if (binding.activeChatId != null) {
    const followUp = getFollowUps(storage, binding.id)
    const prompt = followUp > 0
      ? buildPeerFollowUpPrompt(target, wake.messages, followUp >= MAX_AGENT_FOLLOW_UPS)
      : buildThreadWakePrompt(target, wake.messages, busy)
    return { prompt, lastId: wake.lastId, files: wake.files }
  }
  const excerpt = (m: ChannelMessage) => formatChannelMessage(
    m,
    channelName,
    m.content.length <= WAKE_EXCERPT_MAX_CHARS ? m.content : `${m.content.slice(0, WAKE_EXCERPT_MAX_CHARS)}… (truncated — read_history has the full message)`,
  )
  const root = storage.getChannelMessage(stream.rootMessageId)
  const context = storage
    .listMessages(stream.channelId, { before: stream.rootMessageId, limit: THREAD_CONTEXT_MESSAGES })
    .messages
    .map(excerpt)
  // A session starting over (reset, restart) has seen part of the thread
  // already: everything that is not unread now. Not "up to the read cursor" —
  // the agent's own replies never move its cursor, so its latest answer sat
  // past it and dropped out of both lists.
  const unreadIds = new Set(unreadIn(storage, binding.agentId, stream).map((m) => m.id))
  const earlier = storage
    .listThreadReplies(stream.rootMessageId)
    .filter((m) => !unreadIds.has(m.id))
    .slice(-WAKE_MAX_MESSAGES)
    .map(excerpt)
  const prompt = buildThreadStartPrompt({
    target,
    root: root ? formatChannelMessage(root, channelName) : '(the message is gone)',
    context,
    earlier,
    messages: wake.messages,
    busy,
  })
  // The first turn also sees the images on the message the thread is under.
  const files = root ? latestUniqueImages([...wakeImages([root]), ...wake.files]) : wake.files
  return { prompt, lastId: wake.lastId, files }
}

async function startBindingChat(
  binding: AgentBinding,
  prompt: string,
  workspaceId: number | null,
  isRecovery: boolean,
  files: FileUIPart[] = [],
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

  const stream = streamOfBinding(storage, binding)
  const thread = stream?.kind === 'thread' ? storage.getThread(stream.rootMessageId) : null
  let threadTitle: string | undefined
  if (stream?.kind === 'thread') {
    const channelName = storage.getChannel(stream.channelId)?.name ?? String(stream.channelId)
    const ownerName = thread?.ownerAgentId != null ? storage.getAgent(thread.ownerAgentId)?.name ?? null : null
    instructions += `\n\n${buildThreadSessionPrompt({
      target: streamTarget(channelName, stream),
      channelName,
      ownerName,
      isOwner: thread?.ownerAgentId === binding.agentId,
    })}`
    const root = storage.getChannelMessage(stream.rootMessageId)
    const excerpt = (root?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    threadTitle = `#${channelName} thread${excerpt ? `: ${excerpt}` : ''}`
  }

  // A channel session is named after where it is and who: "#test · luna-dev".
  // Left unnamed it took its first prompt ("New messages in #test (now marked
  // read)…"), which is what its approval notifications and the sidebar showed.
  const channelTitle = stream?.kind === 'channel'
    ? `#${storage.getChannel(stream.channelId)?.name ?? stream.channelId} · ${agent.name}`
    : undefined
  const scopedTask = binding.scopeKind === 'task' ? storage.taskGet(Number(binding.scopeKey)) : null
  const sessionTitle = scopedTask ? `#${scopedTask.number} ${scopedTask.title}` : (threadTitle ?? channelTitle)
  // A title only applies when the chat is created; sessions from before this
  // (or a channel renamed since) are brought in line here.
  if (channelTitle && binding.activeChatId != null) {
    const chats = getChatStorage()
    if (chats && chats.getChatMeta(binding.activeChatId)?.title !== channelTitle) {
      chats.updateChatConfig(binding.activeChatId, { title: channelTitle })
    }
  }

  const messages: UIMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: prompt }, ...files],
    },
  ]

  emitProjectEvent(binding.projectId, {
    type: 'agent_status',
    agentId: agent.id,
    projectId: binding.projectId,
    status: 'active',
  })
  if (binding.scopeKind === 'task') taskTurnStartedAt.set(binding.id, Date.now())

  let ctx
  try {
    ctx = await startServerChat({
      chatId: binding.activeChatId ?? undefined,
      messages,
      providerId: agent.provider,
      // An agent without a model (the hidden spec builders) runs on the provider's default.
      modelId: agent.model || undefined,
      modeId: bindingModeId(agent, binding),
      thinkingLevel: agent.thinkingLevel || undefined,
      workspaceId: workspaceId ?? undefined,
      // A task's session reads as the task in the tree, not as its long first prompt.
      ...(sessionTitle ? { title: sessionTitle } : {}),
      env: resolveAgentEnv(agent),
      instructions,
      agentContext: bindingAgentContext(binding),
    }, {
      // A channel or thread session blocked on an approval or a question raises
      // an inbox row (and a phone push) like a chat you started: nobody watches
      // its own chat, and the channel may not be on screen. Task sessions have
      // their own task_needs_input.
      notifyInbox: binding.scopeKind === 'app' || binding.scopeKind === 'thread',
    })
  } catch (err) {
    console.error(
      `[Orchestrator] startBindingChat: agent=${agent.name} binding=${binding.id} startChat FAILED:`,
      err,
    )
    storage.updateBinding(binding.id, { status: 'idle' })
    taskTurnStartedAt.delete(binding.id)
    emitProjectEvent(binding.projectId, {
      type: 'agent_status',
      agentId: agent.id,
      projectId: binding.projectId,
      status: 'idle',
    })

    // Surface the error in the channel or thread (task/linear bindings have
    // nowhere to post into; scopeKey is a task id / session id there).
    const errMsg = err instanceof Error ? err.message : String(err)
    // A spec ticket whose session cannot start would sit in "building" forever.
    if (binding.scopeKind === 'task') void onTicketTurnEnded(storage, Number(binding.scopeKey), errMsg, binding.id).catch(() => {})
    postBindingNotice(storage, binding, `${agent.name} failed to start: ${errMsg}`)
    if (stream?.kind === 'thread') emitThreadUpdated(storage, stream.rootMessageId)
    throw err
  }

  console.log(
    `[Orchestrator] startBindingChat: binding=${binding.id} chat started chatId=${ctx.chatId}`,
  )
  if (stream?.kind === 'thread') emitThreadUpdated(storage, stream.rootMessageId)
  if (binding.scopeKind === 'task') recordTicketChat(storage, Number(binding.scopeKey), ctx.chatId)
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

      // Surface provider errors as system messages in the channel / thread.
      // (Not for task bindings: their scopeKey is a task id, not a channel.)
      if (errors.length > 0) {
        const agent = storage.getAgent(binding.agentId)
        postBindingNotice(storage, binding, `⚠ ${agent?.name ?? `Agent ${binding.agentId}`} provider error: ${errors.join('; ')}`)
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
        void onTicketTurnEnded(storage, surfaceTaskId, errors.length > 0 ? errors.join('; ') : undefined, binding.id).catch((err) =>
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
      void onTicketTurnEnded(_storage, surfaceTaskId, err instanceof Error ? err.message : String(err), binding?.id).catch(() => {})
    }
  })
}

/** Called by agent-recovery.ts on startup to resume an agent binding with a recovery prompt. */
export async function wakeUpBindingForRecovery(bindingId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const binding = storage.getBinding(bindingId)
  if (!binding || (binding.scopeKind !== 'app' && binding.scopeKind !== 'thread')) return

  const stream = streamOfBinding(storage, binding)
  const channel = stream ? storage.getChannel(stream.channelId) : null
  if (!stream || !channel) return

  let workspaceId = binding.workspaceId
  if (workspaceId == null) {
    workspaceId = await provisionWorkspaceForBinding(binding.agentId, channel.projectId)
    storage.updateBinding(binding.id, { workspaceId })
  }
  storage.updateBinding(binding.id, { status: 'active' })
  // A thread session that never started gets its full first prompt instead.
  if (stream.kind === 'thread' && binding.activeChatId == null) {
    const turn = buildThreadTurnPrompt(storage, binding, stream)
    const chatId = await startBindingChat(binding, turn.prompt, workspaceId, true, turn.files)
    markWakeDelivered(storage, binding, turn.lastId)
    storage.updateBinding(binding.id, { activeChatId: chatId, status: 'active' })
    return
  }
  const wake = collectWakeMessages(storage, binding, channel.name)
  const chatId = await startBindingChat(binding, buildRecoveryPrompt(streamTarget(channel.name, stream), wake.messages), workspaceId, true, wake.files)
  markWakeDelivered(storage, binding, wake.lastId)
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
      modeId: bindingModeId(agent, binding),
      thinkingLevel: agent.thinkingLevel || undefined,
      workspaceId: binding.workspaceId ?? undefined,
      skipSnapshot: true,
      env: resolveAgentEnv(agent),
      // Same context as the session's own turns: anything else changes its MCP
      // servers, and with them the reuse fingerprint, rebuilding the session.
      agentContext: bindingAgentContext(binding),
    })

    const reader = ctx.preparedParts.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    await ctx.persistDone
    ctx.finish()

    console.log(`[Orchestrator] auto-compact completed for binding ${binding.id}`)

    postBindingNotice(storage, binding, `${agent.name} conversation history compacted automatically (context was running low).`)
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
 * Give a spec its coordinator's session: a task binding on the spec itself, in
 * the spec's change worktree (no worktree of its own — it works on the change
 * branch). Recorded as the spec's binding, so a comment on the spec wakes it.
 * Null when the spec has no change worktree.
 */
export function attachSpecCoordinator(specId: number, agentId: number): AgentBinding | null {
  const storage = _storage
  if (!storage) return null
  const spec = storage.taskGet(specId)
  if (!spec || spec.workspaceId == null || !storage.getWorkspace(spec.workspaceId)) return null
  const binding = ensureTaskBinding(storage, spec.id, spec.number, spec.projectId, agentId, spec.workspaceId)
  if (binding.workspaceId !== spec.workspaceId) storage.updateBinding(binding.id, { workspaceId: spec.workspaceId })
  if (spec.bindingId !== binding.id || spec.assignedAgentId !== agentId) {
    storage.taskUpdate(spec.id, { bindingId: binding.id, assignedAgentId: agentId }, { type: 'system', name: 'OperonSpec' })
    broadcastTask(storage, spec.id)
  }
  return storage.getBinding(binding.id) ?? binding
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

/** `note`: said to the agent after the task itself (a ticket handed over from another agent, say). */
export interface DispatchWorkspaceOptions {
  /** Saved on the task, so a later automatic start (in_progress with an assignee) runs the same way. */
  workspaceMode?: TaskWorkspaceMode
  /** `shared` only: which workspace; omit for the parent task's shared one, else the project's main workspace. */
  workspaceId?: number
}

/**
 * The workspace a shared-mode task runs in: the one asked for, else its parent's
 * (sub-tasks of a shared task stay with it), else the project's main workspace.
 */
function resolveSharedWorkspace(storage: Storage, task: Task, workspaceId: number | undefined): Workspace {
  const project = storage.getProject(task.projectId)
  if (!project) throw new Error(`Project ${task.projectId} not found`)
  const pick = (id: number | null | undefined) => {
    if (id == null) return null
    const ws = storage.getWorkspace(id)
    return ws && ws.projectId === task.projectId ? ws : null
  }
  if (workspaceId != null) {
    const ws = pick(workspaceId)
    if (!ws) throw new Error(`Workspace ${workspaceId} is not in this task's project`)
    return ws
  }
  const parent = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  const fromParent = parent?.workspaceMode === 'shared' ? pick(parent.workspaceId) : null
  if (fromParent) return fromParent
  const fromTask = task.workspaceMode === 'shared' ? pick(task.workspaceId) : null
  if (fromTask) return fromTask
  const main = storage.listWorkspaces(task.projectId).find((w) => path.resolve(w.worktreePath) === path.resolve(project.rootPath))
  if (!main) throw new Error(`Project ${project.name} has no main workspace to share — open the project once, or dispatch to a new worktree`)
  return main
}

export async function dispatchProjectTask(
  taskId: number,
  assignedAgentId: number,
  note?: string,
  options: DispatchWorkspaceOptions = {},
): Promise<void> {
  const storage = _storage
  if (!storage) throw new Error('Orchestrator not initialised')

  // A title left blank is being generated; the prompt opens with it, so give it
  // a few seconds before falling back to the placeholder.
  await waitForTaskTitle(taskId)
  const task = storage.taskGet(taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  if (task.specStage != null) throw new Error('Use the Spec controls to run this task')
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

  // Per-task worktree — independent execution agent, no shared workspace — unless
  // the task was sent to a shared workspace. A spec ticket always cuts its own
  // change-scoped branch `operon/task-<N>` off the spec's change branch: the
  // design lives there, and so does every ticket merged before it.
  const parentTask = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  const specParent = parentTask?.specStage != null ? parentTask : null
  const mode: TaskWorkspaceMode = specParent ? 'new' : (options.workspaceMode ?? task.workspaceMode)
  const shared = mode === 'shared'
  const workspace = shared
    ? resolveSharedWorkspace(storage, task, options.workspaceId)
    : specParent
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

  // A sub-task's own worktree belongs under the conversation of the parent task's
  // agent, like the worktree of an external agent a chat dispatched: out of the
  // top of the tree, with the sub-task's session nested under that conversation.
  if (!shared && !specParent && parentTask?.bindingId != null && workspace.originChatId == null) {
    const parentChatId = storage.getBinding(parentTask.bindingId)?.activeChatId
    if (parentChatId != null) storage.setWorkspaceOriginChat(workspace.id, parentChatId)
  }

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
      // A shared workspace's branch is not this task's: Done has nothing of its own to merge.
      branchName: shared ? null : workspace.branchName,
      workspaceId: workspace.id,
      workspaceMode: mode,
      bindingId: binding.id,
    },
    { type: 'agent', id: assignedAgentId, name: agent.name },
  )
  storage.taskAppendActivity(taskId, {
    kind: 'dispatch',
    actorType: 'system',
    actorName: 'system',
    body: shared ? `Dispatched to ${agent.name} in shared workspace ${workspace.name}` : `Dispatched to ${agent.name}`,
    meta: shared
      ? { agentId: assignedAgentId, workspaceMode: 'shared', workspaceId: workspace.id, workspaceName: workspace.name }
      : { agentId: assignedAgentId, branch: workspace.branchName },
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
  // The prompt names the task and leaves its content to get_project_task: a
  // description or discussion can run long, and the tool pages through it
  // instead of landing all of it in one message. Comments left before dispatch
  // live only there, so the read is not optional.
  const readFirstPrompt =
    `\nBefore you start, read the task with get_project_task(task: ${task.number}) — its description ` +
    `and the discussion on it are not repeated here. Long tasks come back in pages: keep calling it ` +
    `with the offset it gives you until you have read everything, then start.\n`
  const taskPrompt =
    `You've been assigned task #${task.number}: ${task.title}\n` +
    readFirstPrompt +
    specTicketPrompt +
    (shared
      ? `\nYou are working in the shared workspace "${workspace.name}" (\`${workspace.worktreePath}\`, ` +
        `currently on \`${workspace.branchName}\`). It is not yours alone: the user and other agents may be ` +
        `editing here too. Change only what this task needs, never reset, stash, check out or discard changes ` +
        `you did not make, and do not commit unless the task asks you to.\n\n`
      : `\nYou are working on branch \`${workspace.branchName}\` in a dedicated worktree — ` +
        `this is your isolated workspace for this task. Implement it here.\n\n`) +
    `Report progress with comment_project_task(task: ${task.number}, body: "...") as you go — ` +
    `when you start, hit a milestone, finish, or get blocked. When your work is ready for ` +
    `human review, call update_project_task(task: ${task.number}, status: "in_review"). ` +
    `Use get_project_task(task: ${task.number}) anytime to re-read the spec and discussion.` +
    (specParent
      ? ''
      : `\n\nIf the user asks for parts of this work to go to other agents, don't do those parts yourself: ` +
        `propose them with propose_subtasks(task: ${task.number}, items: [...]) and end your turn — the user ` +
        `confirms each sub-task's agent and workspace on the board.`) +
    (note ? `\n\n${note}` : '')

  // Images on the description and on comments left before dispatch: the agent
  // reads those comments as text (get_project_task) but can only see images sent as files.
  const descriptionFiles = taskAttachmentFiles([
    ...task.attachments,
    ...storage.taskListActivity(taskId).filter((a) => a.kind === 'comment').flatMap(activityAttachments),
  ].slice(0, 20))
  await deliverToBinding(
    storage,
    {
      binding,
      injectNotification: () => taskPrompt,
      wakePrompt: taskPrompt,
      ensureWorkspace: () => Promise.resolve(workspace.id),
      startChat: (prompt, workspaceId) => startBindingChat(binding, prompt, workspaceId, false, descriptionFiles),
      files: descriptionFiles,
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

/** `pending`: not done, but under way — the spec's coordinator is resolving a sign-off conflict. */
type CompletionResult = { ok: true } | { ok: false; reason: string; pending?: true }

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

  // A shared-mode task changed a workspace it does not own: nothing of its own to
  // merge, and the workspace stays.
  if (task.workspaceMode === 'shared' && task.specStage == null) {
    storage.taskUpdate(taskId, { status: 'done' }, { type: actor.type, id: actor.id ?? undefined, name: actor.name })
    broadcastTask(storage, taskId)
    return { ok: true }
  }

  // A ticket of an OperonSpec merges into the spec's change branch; a person's
  // Done is the way past its automatic review.
  const changeParent = task.parentTaskId != null ? storage.taskGet(task.parentTaskId) : null
  if (changeParent?.specStage != null) {
    const landed = await landSpecTicket(taskId, actor)
    return landed.ok ? landed : { ok: false, reason: landed.reason }
  }
  const specWorkspace = task.specStage != null && task.workspaceId != null ? storage.getWorkspace(task.workspaceId) : null
  if (task.specStage != null) {
    const open = storage.taskListChildren(task.id).filter((c) => c.status !== 'done' && c.status !== 'cancelled')
    if (open.length > 0) {
      return { ok: false, reason: `Tickets still open: ${open.map((c) => `#${c.number}`).join(', ')}` }
    }
    const run = storage.specRunGet(task.id)
    if (run?.stage === 'integrating') {
      return { ok: false, reason: 'The coordinator is still resolving the conflict from the last sign-off; sign off once it has been reviewed.', pending: true }
    }
    if (!specWorkspace) return { ok: false, reason: `Spec #${task.number} has lost its change worktree` }
    try {
      await restoreSpecFiles(storage, { taskId: task.id, taskNumber: task.number, worktreePath: specWorkspace.worktreePath })
    } catch (error) {
      return { ok: false, reason: `Could not restore the spec's files: ${error instanceof Error ? error.message : String(error)}` }
    }
    // What lands is what was reviewed: a commit since then would ride in unseen.
    if (run?.stage === 'awaiting_signoff') {
      const unreviewed = await unreviewedFiles(storage, task)
      if (unreviewed.length > 0) {
        const files = unreviewed.slice(0, 5).map((f) => `\`${f}\``).join(', ') + (unreviewed.length > 5 ? ` and ${unreviewed.length - 5} more` : '')
        return {
          ok: false,
          reason:
            `\`${task.branchName}\` changed after its review, in ${files}, and nobody has reviewed that. ` +
            'Request changes to have the change reviewed again, then sign off.',
        }
      }
    }
    // Integrate the latest default branch before archiving the execution files.
    if (specWorkspace) {
      try {
        const project = storage.getProject(task.projectId)
        if (project) {
          const target = (await getDefaultLocalBranch(project.rootPath)) ?? (await getCurrentBranch(project.rootPath))
          if (target) await mergeBranch(specWorkspace.worktreePath, target, `Merge ${target} into ${task.branchName} before sign-off`)
        }
      } catch (err) {
        if (err instanceof MergeConflictError) {
          const files = err.files.join(', ') || 'some files'
          // The coordinator resolves it on the change branch; the resolution is reviewed before gate 2 again.
          if (run?.stage === 'awaiting_signoff' && (await startIntegration(storage, task, err.branch, err.files))) {
            return {
              ok: false,
              pending: true,
              reason:
                `${err.branch} has changed since this spec branched, and merging it in conflicts in ${files}. ` +
                "The spec's coordinator is resolving it; once a reviewer has checked the result, sign off again.",
            }
          }
          return {
            ok: false,
            reason:
              `The default branch has changed since this spec branched, and merging it in conflicts in ${files}. ` +
              `Request changes asking for ${err.branch} to be merged in and the conflicts resolved — that is built and reviewed ` +
              `like any ticket — then sign off again.`,
          }
        }
        return { ok: false, reason: `Could not prepare the spec for sign-off: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }

  let merged: CompletionResult
  if (specWorkspace) {
    const loc: SpecLocation = { taskId: task.id, taskNumber: task.number, worktreePath: specWorkspace.worktreePath }
    try {
      merged = await withSpecFilesArchived(storage, loc, () => mergeTaskBranchToDefault(taskId, actor))
    } catch (error) {
      return { ok: false, reason: `Could not archive the spec's files: ${error instanceof Error ? error.message : String(error)}` }
    }
  } else {
    merged = await mergeTaskBranchToDefault(taskId, actor)
  }
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
 * Reclaim a task's worktree + workspace row — after its merge (done), or when it
 * is archived or cancelled. Force-removes the git worktree DIRECTORY only — the
 * branch is kept (its commits live on, reach main via the change merge, and let
 * `restoreSpecWorktree` check it out again). Drops the workspace row and clears
 * the now-dangling pointers on the task + its binding so a later re-dispatch
 * re-provisions cleanly. Best-effort: failures are logged, never thrown.
 */
export async function cleanupTaskWorktree(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.workspaceId == null) return
  // Not the task's to remove: a shared workspace outlives every task run in it.
  if (task.workspaceMode === 'shared') return
  const staleWsId = task.workspaceId
  const ws = storage.getWorkspace(staleWsId)
  const project = storage.getProject(task.projectId)
  if (ws && project && path.resolve(ws.worktreePath) !== path.resolve(project.rootPath)) {
    try {
      if (existsSync(ws.worktreePath)) await worktreeRemove(project.rootPath, ws.worktreePath, true)
      else await worktreePrune(project.rootPath)
    } catch (err) {
      console.warn(`[Cleanup] worktree remove failed for task ${taskId}:`, err)
    }
  }
  forgetWorkspace(storage, task.projectId, staleWsId)
}

/**
 * Drop a workspace row and every pointer at it — the tasks and task bindings that
 * ran in it — so nothing dangles and a later dispatch provisions afresh.
 */
function forgetWorkspace(storage: Storage, projectId: number, workspaceId: number): void {
  const ws = storage.getWorkspace(workspaceId)
  storage.deleteWorkspace(workspaceId)
  if (ws) void RewindService.removeRepo(ws.worktreePath)
  for (const task of storage.taskList({ projectId, includeArchived: true })) {
    if (task.workspaceId !== workspaceId) continue
    storage.taskUpdate(task.id, { workspaceId: null }, { type: 'system', name: 'system' })
    broadcastTask(storage, task.id)
  }
  for (const binding of storage.listBindings({ scopeKind: 'task', projectId })) {
    if (binding.workspaceId === workspaceId) storage.updateBinding(binding.id, { workspaceId: null })
  }
}

/** Archived or cancelled: the task is set aside, and nothing should keep running for it. */
function isParked(task: Task): boolean {
  return task.archivedAt != null || task.status === 'cancelled'
}

/**
 * Every task write passes through `onTaskChange`, so this is where a task that
 * was just set aside gives its worktree back — whichever path archived or
 * cancelled it — and an open spec brought back gets its change worktree again.
 */
function onTaskChanged(before: Task, after: Task): void {
  if (!isParked(before) && isParked(after)) {
    void reclaimParkedTaskWorktree(after.id).catch((err) => console.warn(`[Cleanup] reclaim failed for task ${after.id}:`, err))
  } else if (isParked(before) && !isParked(after)) {
    void restoreSpecWorktree(after.id).catch((err) => console.warn(`[Cleanup] spec worktree restore failed for task ${after.id}:`, err))
  }
}

/** Stop what still runs in a parked task's worktree, then delete it. */
async function reclaimParkedTaskWorktree(taskId: number): Promise<void> {
  const storage = _storage
  if (!storage) return
  const task = storage.taskGet(taskId)
  if (!task || task.workspaceId == null) return
  stopDesignRun(task.id)
  const binding = task.bindingId != null ? storage.getBinding(task.bindingId) : null
  if (binding?.activeChatId != null) abortChat(binding.activeChatId)
  await cleanupTaskWorktree(task.id)
}

/**
 * Give an open spec back its change worktree after it was archived or cancelled
 * and then brought back: the spec's files live on its branch, and every spec
 * step reads them from this worktree. Ordinary tasks and spec tickets don't need
 * this — dispatch provisions their worktree on demand.
 */
export async function restoreSpecWorktree(taskId: number): Promise<boolean> {
  const storage = _storage
  if (!storage) return false
  const task = storage.taskGet(taskId)
  if (!task || task.specStage == null || task.specStage === 'done') return false
  if (task.workspaceId != null || !task.branchName || isParked(task) || task.status === 'done') return false
  const project = storage.getProject(task.projectId)
  if (!project) return false
  if (!(await localBranchExists(project.rootPath, task.branchName))) return false
  const worktreePath = worktreePathFor(project.id, project.rootPath, `task-${task.number}`)
  const registered = (await worktreeList(project.rootPath)).some((w) => path.resolve(w.path) === path.resolve(worktreePath))
  if (!registered) {
    if (existsSync(worktreePath)) {
      console.warn(`[Cleanup] can't restore spec #${task.number}: ${worktreePath} exists but isn't a worktree`)
      return false
    }
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
    await worktreeAdd(project.rootPath, worktreePath, task.branchName, false)
  }
  const workspace = storage.createWorkspace(project.id, {
    name: `Spec · task #${task.number}`,
    branchName: task.branchName,
    worktreePath,
  })
  storage.taskUpdate(task.id, { workspaceId: workspace.id }, { type: 'system', name: 'system' })
  broadcastTask(storage, task.id)
  return true
}

/**
 * Wake an idle/offline task binding with a notification (e.g. a comment on its
 * task) — the local analog of Linear's "post a comment to resurrect the
 * session". Reuses deliverToBinding: injects into the running chat, or starts a
 * fresh one with the notification as the prompt. Returns false if it couldn't
 * be woken.
 */
/** Stop a task's running turn; its session stays, to be woken again. False when nothing was running. */
export function stopTaskSession(taskId: number): boolean {
  const storage = _storage
  const task = storage?.taskGet(taskId)
  const binding = task?.bindingId != null ? storage?.getBinding(task.bindingId) : null
  if (!storage || !binding?.activeChatId) return false
  const stopped = abortChat(binding.activeChatId)
  if (stopped) storage.updateBinding(binding.id, { status: 'idle' })
  return stopped
}

/**
 * Take a task off its session — to hand it to another agent. The turn is
 * stopped, the session torn down and the task no longer points at it, so how
 * that turn ends is not the task's business any more. The worktree stays: the
 * next session picks up where this one left off.
 */
export async function detachTaskSession(taskId: number): Promise<void> {
  const storage = _storage
  const task = storage?.taskGet(taskId)
  if (!storage || !task || task.bindingId == null) return
  const binding = storage.getBinding(task.bindingId)
  storage.taskUpdate(taskId, { bindingId: null }, { type: 'system', name: 'OperonSpec' })
  if (binding) await resetBinding(storage, binding)
  broadcastTask(storage, taskId)
}

export async function wakeTaskBinding(bindingId: number, notification: string, files: FileUIPart[] = []): Promise<boolean> {
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
        startChat: (prompt, workspaceId) => startBindingChat(binding, prompt, workspaceId, false, files),
        files,
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
    announceTaskTurn(binding)
  },
}

/** The task's current agent session: its conversation, where it runs, and who runs it. */
function taskSessionOf(storage: Storage, taskId: number): TaskSessionRef | null {
  const task = storage.taskGet(taskId)
  if (!task || task.bindingId == null) return null
  const binding = storage.getBinding(task.bindingId)
  if (!binding) return null
  return { chatId: binding.activeChatId ?? null, workspaceId: binding.workspaceId ?? null, agentId: binding.agentId }
}

/** A task turn the orchestrator started has settled: tell the user once, on the task. */
function announceTaskTurn(binding: AgentBinding): void {
  const startedAt = taskTurnStartedAt.get(binding.id)
  taskTurnStartedAt.delete(binding.id)
  const storage = _storage
  if (startedAt == null || !storage) return
  const task = storage.taskGet(Number(binding.scopeKey))
  // A session the task was handed away from speaks for nobody.
  if (!task || task.bindingId !== binding.id || task.archivedAt != null) return
  // OperonSpec work announces its own gates; its tickets wait on reviewer agents.
  if (task.specStage != null || isReviewedTicket(storage, task.id)) return
  notifyTaskTurnFinished(
    storage,
    task,
    { chatId: binding.activeChatId ?? null, workspaceId: binding.workspaceId ?? null, agentId: binding.agentId },
    startedAt,
  )
}

// ---- Finish handler ----

/**
 * With unread pending for a channel binding, decide whether it warrants a new
 * turn: always for a human message, a bounded number of times when only other
 * agents spoke (the count is kept in the binding's metadata). Used at turn end
 * and by startup recovery.
 */
export function planChannelRewake(binding: AgentBinding): boolean {
  const storage = _storage
  if (!storage) return true
  const agentId = binding.agentId
  const stream = streamOfBinding(storage, binding)
  if (!stream) return false
  const unread = unreadIn(storage, agentId, stream)
  const plan = planRewake(unread, getFollowUps(storage, binding.id))
  if (plan.kind === 'wake') {
    setFollowUps(storage, binding.id, plan.followUp)
    return true
  }
  if (plan.reason === 'nothing-new' && unread.length > 0) {
    // Only system notices are left — mark them read so they don't resurface.
    markReadIn(storage, agentId, stream, unread[unread.length - 1].id)
  }
  // follow-up-limit: leave the agent messages unread; the next human message
  // wakes the agent and check_messages shows them then.
  console.log(`[Orchestrator] planRewake: binding=${binding.id} skip (${plan.reason})`)
  return false
}

/**
 * Built-in channel ('app') platform adapter for the shared binding driver.
 * Unread is the channel's per-agent unread queue; re-wake resumes the channel
 * session; a tripped breaker posts a system message; idle emits agent_status.
 */
const channelAdapter: BindingPlatformAdapter = {
  scopeKinds: new Set(['app']),
  logTag: 'Orchestrator',
  buildInjectNotification: (binding, count) => buildStreamNotification(binding, count),
  ensureWorkspace: (binding) => {
    const projectId = binding.projectId
    if (projectId == null) return Promise.resolve(null)
    return provisionWorkspaceForBinding(binding.agentId, projectId)
  },
  startChat: async (binding, workspaceId) => {
    const storage = _storage
    if (!storage) throw new Error('Orchestrator not initialised')
    const name = storage.getChannel(Number(binding.scopeKey))?.name ?? binding.scopeKey
    // The wake-up prompt is the messages themselves: nothing to "go check" (and
    // announce in the channel) before the agent can answer them.
    const wake = collectWakeMessages(storage, binding, name)
    const followUp = getFollowUps(storage, binding.id)
    const prompt = followUp > 0
      ? buildPeerFollowUpPrompt(`#${name}`, wake.messages, followUp >= MAX_AGENT_FOLLOW_UPS)
      : buildWakeUpPrompt(`#${name}`, wake.messages)
    const chatId = await startBindingChat(binding, prompt, workspaceId, false, wake.files)
    markWakeDelivered(storage, binding, wake.lastId)
    return chatId
  },
  getUnreadCount: (binding) => streamUnreadCount(binding),
  planRewake: (binding) => {
    // The turn is over; a pending peer nudge is judged here instead.
    cancelPeerNudge(binding.id)
    return planChannelRewake(binding)
  },
  onBreakerTrip: (binding, unreadCount) => postBreakerNotice(binding, unreadCount),
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

// ---- Shared by the channel and thread adapters ----

function streamUnreadCount(binding: AgentBinding): number {
  const storage = _storage
  const stream = storage ? streamOfBinding(storage, binding) : null
  return storage && stream ? unreadIn(storage, binding.agentId, stream).length : 0
}

function buildStreamNotification(binding: AgentBinding, count: number): string {
  const storage = _storage
  const stream = storage ? streamOfBinding(storage, binding) : null
  if (!storage || !stream) {
    return `[System notification: You have ${count} new message(s). Call check_messages to read them when you're ready.]`
  }
  // Read at send time (after the debounce), so the count matches what check_messages returns.
  const unread = unreadIn(storage, binding.agentId, stream)
  return (
    `[System notification: You have ${unread.length || count} new message(s) in ${bindingWhere(storage, stream)}${describeSenders(unread)}. ` +
    `Call check_messages to read them when you're ready.]`
  )
}

function postBreakerNotice(binding: AgentBinding, unreadCount: number): void {
  const storage = _storage
  if (!storage) return
  const agentName = storage.getAgent(binding.agentId)?.name ?? `Agent ${binding.agentId}`
  postBindingNotice(
    storage,
    binding,
    `${agentName} failed to respond after ${MAX_IDLE_RETRIES} attempts ` +
      `(${unreadCount} unread). Likely a provider error — check the agent's model/provider configuration.`,
  )
}

/**
 * Thread sessions ('thread' bindings): the same turn loop as a channel session,
 * on the thread's stream. The first turn starts from the thread's root and the
 * channel messages before it; the workspace is the one the binding was created
 * with (its agent's shared workspace).
 */
const threadAdapter: BindingPlatformAdapter = {
  scopeKinds: new Set(['thread']),
  logTag: 'Thread',
  buildInjectNotification: (binding, count) => buildStreamNotification(binding, count),
  ensureWorkspace: (binding) => {
    const projectId = binding.projectId
    if (projectId == null) return Promise.resolve(null)
    const channelSession = _storage?.listBindings({ scopeKind: 'app', agentId: binding.agentId, projectId })
      .find((b) => b.workspaceId != null)
    return channelSession?.workspaceId != null
      ? Promise.resolve(channelSession.workspaceId)
      : provisionWorkspaceForBinding(binding.agentId, projectId)
  },
  startChat: async (binding, workspaceId) => {
    const storage = _storage
    if (!storage) throw new Error('Orchestrator not initialised')
    const stream = streamOfBinding(storage, binding)
    if (stream?.kind !== 'thread') throw new Error(`binding ${binding.id} is not a thread session`)
    const turn = buildThreadTurnPrompt(storage, binding, stream)
    const chatId = await startBindingChat(binding, turn.prompt, workspaceId, false, turn.files)
    markWakeDelivered(storage, binding, turn.lastId)
    return chatId
  },
  getUnreadCount: (binding) => streamUnreadCount(binding),
  planRewake: (binding) => {
    cancelPeerNudge(binding.id)
    return planChannelRewake(binding)
  },
  onBreakerTrip: (binding, unreadCount) => postBreakerNotice(binding, unreadCount),
  onIdle: (binding) => {
    if (binding.projectId != null) {
      emitProjectEvent(binding.projectId, {
        type: 'agent_status',
        agentId: binding.agentId,
        projectId: binding.projectId,
        status: 'idle',
      })
    }
    const storage = _storage
    if (storage) emitThreadUpdated(storage, Number(binding.scopeKey))
  },
}

/**
 * Called when an agent's chat stream ends (per binding). Thin wrapper over the
 * shared driver with the binding's adapter — kept so drainAgentChat can trigger
 * a finish by binding id without knowing about adapters.
 */
export async function handleBindingFinish(bindingId: number): Promise<void> {
  if (!_storage) return
  // Task turns drain through here too; the channel adapter ignores task scope, so
  // without this a finished task binding stayed 'active' forever.
  const kind = _storage.getBinding(bindingId)?.scopeKind
  const adapter = kind === 'task' ? taskFinishAdapter : kind === 'thread' ? threadAdapter : channelAdapter
  await driverHandleFinish(_storage, adapter, bindingId)
}

/**
 * Tear down an agent's thread sessions in a channel (it left the channel, or
 * the channel is going away) and hand back the threads it owned there.
 */
export async function dropThreadSessions(channelId: number, agentId: number | null): Promise<void> {
  const storage = _storage
  if (!storage) return
  for (const thread of storage.listThreads(channelId, { limit: 100_000 })) {
    for (const binding of storage.listBindingsForScope('thread', String(thread.rootMessageId))) {
      if (agentId != null && binding.agentId !== agentId) continue
      await resetBinding(storage, binding)
      storage.deleteBinding(binding.id)
    }
  }
  if (agentId != null) storage.releaseThreadsOwnedBy(channelId, agentId)
}

// Re-export so unchanged callers compile — first-startup prompt constant is
// referenced in agent-recovery.
export { FIRST_STARTUP_PROMPT }
