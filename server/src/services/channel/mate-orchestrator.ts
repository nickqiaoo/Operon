/**
 * Mate-mode orchestrator — wakes an agent when a new IM message arrives.
 *
 * Per-binding model: a mate agent can be bound to N IM channels; each binding
 * (agent_bindings row, scope_kind in {'slack','telegram'}) owns its own chat,
 * system prompt, drain loop, retry counter, and status. Two messages to the
 * same agent in two different channels run as independent concurrent turns.
 *
 * Status now lives in agent_bindings.status (was previously in-memory). DB
 * holds active_chat_id so we can resume a session across restarts.
 *
 * Workspace is fixed at binding-setup time (wizard writes binding.workspace_id).
 * No ensureAgentWorktree here — the wizard chose an existing workspace.
 *
 * Turn-boundary invariant (parallels agent-orchestrator): at the top of
 * handleMateFinish, cancel any pending inject-notification debounce. Pending
 * unread is found by DB scan, so either the re-wake covers it or we settle
 * idle — the debounced inject would always be stale at that point.
 */

import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  IMStorageAdapter,
  ProjectStorageAdapter,
} from '../../storage/interface.js'
import type { IMMessageRow, IMSource } from '../../types/im.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import { startChat, abortChat } from '../ai.js'
import {
  buildMateAgentSystemPrompt,
  buildMateWakeUpPrompt,
  buildMateInjectNotification,
  MATE_FIRST_STARTUP_PROMPT,
} from './agent-system-prompt.js'
import { resolveAgentEnv } from './agent-env.js'
import { resetBinding } from './binding-reset.js'
import { cancelDebounce } from './debounce-manager.js'
import {
  deliverBinding,
  handleBindingFinish as driverHandleFinish,
  registerBindingAdapter,
  initBindingFinishDispatch,
  clearBindingRetry,
  MAX_IDLE_RETRIES,
  type BindingPlatformAdapter,
} from '../binding-driver.js'
import type { IMProvider } from '../../gateway/im/types.js'
import type { IMProviderRegistry } from '../../gateway/im/registry.js'
import type { PermissionHandler } from '../../gateway/im/permission-handler.js'
import { forwardApprovalEvent } from '../../gateway/im/approval-forwarder.js'
import type { RuntimeTextStreamPart } from '@operon/agent-runtime'

type ApprovalRequestPart = Extract<RuntimeTextStreamPart, { type: 'tool-approval-request' }>

type Storage = IMStorageAdapter
  & ChannelStorageAdapter
  & ProjectStorageAdapter
  & AgentBindingStorageAdapter

/** Emoji reaction posted on every trigger message as an immediate ack. */
const DEFAULT_ACK_REACTION = 'eyes'
const ACK_REACTION_BY_PROVIDER: Record<string, string> = {
  codex: 'codex',
  kimi: 'kimi',
}

/** Mate scope kinds set — readable filter for binding queries. */
const MATE_SCOPE_KINDS = new Set<AgentBinding['scopeKind']>(['slack', 'telegram'])

let _storage: Storage | null = null
let _registry: IMProviderRegistry | null = null
let _permissionHandler: PermissionHandler | null = null

export function initMateOrchestrator(
  storage: Storage,
  registry: IMProviderRegistry,
  permissionHandler: PermissionHandler,
): void {
  _storage = storage
  _registry = registry
  _permissionHandler = permissionHandler
  registerBindingAdapter(mateAdapter)
  initBindingFinishDispatch(storage)
}

export interface MateWakeParams {
  agentId: number
  source: string
  sourceChannel: string
  bindingId: number
  workspaceId: number
  trigger: IMMessageRow
}

/**
 * Wake a mate agent in response to an incoming IM message.
 *
 * Contract: fire-and-forget from the inbound pipeline. Failures are logged,
 * not thrown. Best-effort emoji reaction happens before the status branch so
 * the human sees an ack even on cold starts.
 */
export async function wakeMate(params: MateWakeParams): Promise<void> {
  const storage = _storage
  const registry = _registry
  if (!storage || !registry) {
    console.warn('[MateOrchestrator] not initialised — dropping wake')
    return
  }

  const { agentId, source, sourceChannel, bindingId, trigger } = params

  const binding = storage.getBinding(bindingId)
  if (!binding || !MATE_SCOPE_KINDS.has(binding.scopeKind)) {
    console.warn(`[MateOrchestrator] no binding ${bindingId} for agent=${agentId}`)
    return
  }
  if (binding.imProviderInstanceId == null) {
    console.warn(`[MateOrchestrator] binding ${bindingId} missing im_provider_instance_id`)
    return
  }

  const provider = registry.getProvider(binding.imProviderInstanceId)
  if (!provider) {
    console.warn(`[MateOrchestrator] provider ${binding.imProviderInstanceId} not running`)
    return
  }

  const agent = storage.getAgent(agentId)
  if (!agent) {
    console.warn(`[MateOrchestrator] agent ${agentId} not found`)
    return
  }

  // Fire-and-forget ack so the sender sees we received the message.
  postAckReaction(provider, trigger, agent.provider)

  const status = binding.status
  const chatId = binding.activeChatId
  console.log(
    `[MateOrchestrator] wakeMate: agent=${agent.name}(${agentId}) binding=${bindingId} ` +
    `status=${status} chatId=${chatId ?? 'none'} trigger=${source}:${sourceChannel} ` +
    `row=${trigger.id} ts=${trigger.sourceTs ?? 'null'} senderKind=${trigger.senderKind} ` +
    `senderAgentId=${trigger.senderAgentId ?? 'null'} ` +
    `text=${JSON.stringify((trigger.text ?? '').slice(0, 120))}`,
  )

  try {
    // 3-state dispatch (active→inject / idle→wake / offline→cold-start), debounce
    // and inject-fallback all live in the shared driver. Mate only supplies the
    // platform adapter (prompts, IM workspace, startChat).
    await deliverBinding(storage, mateAdapter, binding)
  } catch (err) {
    console.error(`[MateOrchestrator] wakeMate error binding=${bindingId}:`, err)
  }
}

export interface MateInterruptParams {
  bindingId: number
  agentId: number
  reason: 'stop_command'
  text: string
  message: IMMessageRow
}

/**
 * User-invoked /stop — abort this binding's current turn. Next inbound message
 * on the same channel wakes a fresh turn.
 */
export function interruptMate(params: MateInterruptParams): void {
  const storage = _storage
  if (!storage) {
    console.warn('[MateOrchestrator] not initialised — dropping interrupt')
    return
  }
  const binding = storage.getBinding(params.bindingId)
  if (!binding?.activeChatId) {
    console.log(`[MateOrchestrator] interrupt binding=${params.bindingId}: no active chat`)
    return
  }
  const aborted = abortChat(binding.activeChatId)
  console.log(
    `[MateOrchestrator] interrupt binding=${params.bindingId} agent=${params.agentId} ` +
    `reason=${params.reason} aborted=${aborted}`,
  )
}

export interface MateResetParams {
  bindingId: number
  agentId: number
  source: IMSource
  sourceChannel: string
  message: IMMessageRow
}

/**
 * User-invoked /reset — abort any active turn and clear this binding's chat
 * pointer so the next wake on this channel starts a brand-new chat (cold
 * start, first-startup prompt). Chat history is preserved. Cursor is advanced
 * past the /reset message so the fresh session doesn't treat the command
 * itself as unread.
 */
export async function resetMate(params: MateResetParams): Promise<void> {
  const storage = _storage
  if (!storage) {
    console.warn('[MateOrchestrator] not initialised — dropping reset')
    return
  }

  const binding = storage.getBinding(params.bindingId)
  if (!binding) {
    console.warn(`[MateOrchestrator] reset: binding ${params.bindingId} not found`)
    return
  }

  const previousChatId = binding.activeChatId
  await resetBinding(storage, binding)

  // Advance cursor past the /reset trigger so the fresh session doesn't treat
  // the slash command itself as unread.
  storage.upsertCursor(
    params.agentId,
    'mate',
    `${params.source}:${params.sourceChannel}`,
    params.message.id,
  )

  cancelDebounce(`binding:${params.bindingId}`)
  clearBindingRetry(params.bindingId)

  console.log(
    `[MateOrchestrator] reset binding=${params.bindingId} agent=${params.agentId} ` +
    `previousChatId=${previousChatId ?? 'none'}`,
  )
}

/**
 * Start (or resume) a mate binding's chat and return the new chatId. The shared
 * driver owns status / activeChatId mutation and the active/idle/offline
 * decision; this only assembles the prompt + system prompt and kicks off the
 * drain. Cold start (no existing chat) uses the first-startup prompt; otherwise
 * the channel-scoped wake prompt.
 */
async function startMateChat(binding: AgentBinding, workspaceId: number | null): Promise<number> {
  const storage = _storage
  if (!storage) throw new Error('MateOrchestrator not initialised')
  if (workspaceId == null) throw new Error(`mate binding ${binding.id} has no workspace`)

  const agent = storage.getAgent(binding.agentId)
  if (!agent) throw new Error(`agent ${binding.agentId} not found for binding ${binding.id}`)

  // Derive projectId from workspace so the runtime layer (imBridge MCP etc.)
  // can thread project context. Workspace is fixed by the setup wizard.
  const workspace = storage.getWorkspace(workspaceId)
  if (!workspace) throw new Error(`workspace ${workspaceId} not found for binding ${binding.id}`)
  const projectId = workspace.projectId

  const source = binding.scopeKind as IMSource
  const sourceChannel = binding.scopeKey

  const provider = binding.imProviderInstanceId != null
    ? _registry?.getProvider(binding.imProviderInstanceId)
    : undefined
  const fragments: string[] = []
  const fragment = provider?.systemPromptFragment?.()
  if (fragment) fragments.push(fragment)

  const existingChatId = binding.activeChatId ?? undefined
  const isFirstStartup = !existingChatId
  const prompt = isFirstStartup
    ? MATE_FIRST_STARTUP_PROMPT
    : buildMateWakeUpPrompt(source, sourceChannel)

  const messages: UIMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    },
  ]

  const ctx = await startChat({
    chatId: existingChatId,
    messages,
    providerId: agent.provider,
    modelId: agent.model,
    modeId: agent.permissionMode || undefined,
    workspaceId,
    env: resolveAgentEnv(agent),
    // Persona travels as session instructions, re-derived on EVERY start —
    // resume does not restore a previous system prompt, so a first-startup-only
    // system message would silently lose the persona after an app restart.
    instructions: buildMateAgentSystemPrompt(agent, fragments),
    agentContext: {
      agentId: binding.agentId,
      projectId,
      imBridge: true,
    },
  })
  drainMateChat(ctx, binding.id)
  return ctx.chatId
}

function drainMateChat(
  ctx: Awaited<ReturnType<typeof startChat>>,
  bindingId: number,
): void {
  ;(async () => {
    const reader = ctx.preparedParts.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const part = value?.part
        if (part?.type === 'tool-approval-request') {
          await forwardMateApproval(ctx.chatId, bindingId, part)
        }
      }
    } finally {
      await ctx.persistDone
      ctx.finish()
      // handleMateFinish is also invoked by registerAgentFinishCallback
      // (in chat-flow), but calling it here guarantees prompt follow-up
      // for streams that bypass that callback. Both paths are idempotent.
      handleMateFinish(bindingId).catch((err) => {
        console.error(`[MateOrchestrator] handleMateFinish error binding=${bindingId}:`, err)
      })
    }
  })().catch((err) => {
    console.error(`[MateOrchestrator] drain error binding=${bindingId}:`, err)
  })
}

/**
 * Route a tool-approval-request event to the binding's channel.
 * Approval path is deterministic: chatId → binding → channel (no guessing).
 */
async function forwardMateApproval(
  chatId: number,
  bindingId: number,
  part: ApprovalRequestPart,
): Promise<void> {
  const storage = _storage
  const registry = _registry
  const handler = _permissionHandler
  if (!storage || !registry || !handler) return

  const binding = storage.getBinding(bindingId)
  if (!binding || binding.imProviderInstanceId == null) {
    console.warn(`[MateOrchestrator] approval: binding ${bindingId} not found or missing provider`)
    return
  }

  const provider = registry.getProvider(binding.imProviderInstanceId)
  if (!provider) {
    console.warn(`[MateOrchestrator] approval: provider ${binding.imProviderInstanceId} not running`)
    return
  }

  await forwardApprovalEvent({
    event: part,
    handler,
    provider,
    ref: { sourceChannel: binding.scopeKey },
    channelKey: `${binding.scopeKind}:${binding.scopeKey}`,
    internalChatId: chatId,
  })
}

/**
 * IM (slack/telegram) platform adapter for the shared binding driver. Unread is
 * scanned from im_messages; a fresh turn resumes/cold-starts the mate chat; a
 * tripped breaker posts an IM notice; idle needs no extra side effect.
 */
const mateAdapter: BindingPlatformAdapter = {
  scopeKinds: MATE_SCOPE_KINDS,
  logTag: 'MateOrchestrator',
  buildInjectNotification: (binding, count) =>
    buildMateInjectNotification(count, binding.scopeKind, binding.scopeKey),
  // Workspace is fixed at setup-wizard time; never auto-provisioned here.
  ensureWorkspace: (binding) => Promise.resolve(binding.workspaceId ?? null),
  startChat: (binding, workspaceId) => startMateChat(binding, workspaceId),
  getUnreadCount: (binding) =>
    _storage?.getUnreadIMMessages(
      binding.agentId,
      binding.scopeKind as IMSource,
      binding.scopeKey,
      50,
    ).length ?? 0,
  onBreakerTrip: (binding, unreadCount) => postBreakerNotice(binding, unreadCount),
  onIdle: () => {},
}

/**
 * Called when a mate binding's chat stream ends. Thin wrapper over the shared
 * driver with the mate adapter — kept so drainMateChat can trigger a finish by
 * binding id. (Both this and the unified finish dispatch may fire; the driver
 * is idempotent.)
 */
export async function handleMateFinish(bindingId: number): Promise<void> {
  if (!_storage) return
  await driverHandleFinish(_storage, mateAdapter, bindingId)
}

function postAckReaction(
  provider: IMProvider,
  trigger: IMMessageRow,
  runtimeProviderId: string,
): void {
  if (!provider.capabilities.has('reactions') || !provider.addReaction) return
  if (!trigger.sourceTs) return
  const emoji = ACK_REACTION_BY_PROVIDER[runtimeProviderId] ?? DEFAULT_ACK_REACTION
  const ref = {
    sourceChannel: trigger.sourceChannel,
    threadRef: trigger.threadRef ?? undefined,
  }
  provider.addReaction(ref, trigger.sourceTs, emoji).catch((err) => {
    console.warn(`[MateOrchestrator] reaction failed agent=${provider.agentId}:`, err)
  })
}

async function postBreakerNotice(
  binding: AgentBinding,
  unreadCount: number,
): Promise<void> {
  const storage = _storage
  const registry = _registry
  if (!storage || !registry || binding.imProviderInstanceId == null) return

  const agent = storage.getAgent(binding.agentId)
  const agentName = agent?.name ?? `Agent ${binding.agentId}`
  const provider = registry.getProvider(binding.imProviderInstanceId)
  if (!provider) return

  const message =
    `⚠ ${agentName} failed to respond after ${MAX_IDLE_RETRIES} attempts ` +
    `(${unreadCount} unread). Check the agent's model/provider configuration.`
  try {
    await provider.sendPlain({ sourceChannel: binding.scopeKey }, message)
  } catch (err) {
    console.error(`[MateOrchestrator] breaker notice send failed binding=${binding.id}:`, err)
  }
}
