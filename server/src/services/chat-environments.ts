// The additional environments of an Operon chat.
//
// Once a chat has a session, the session's environment declaration (kept by the framework) is the
// only record of them: this module reads and changes it there and never copies it into the chat.
// Before that — a chat created ahead of its first turn, such as a scheduled message or a workflow
// sub-agent's — `metadata.additionalSshEnvironments` holds the ones to declare when the session is
// created, and the first turn clears it (`clearPendingEnvironments`).
import type { ChatStorageAdapter } from '../storage/interface.js'
import type { ChatMetadata } from '../types/chat.js'
import {
  connectSshEnvironment,
  declareEnvironments,
  declaredEnvironments,
  environmentBinding,
  getSshEnvironment,
  localRef,
  type DeclaredEnvironment,
} from './ssh-environments.js'
import { isChatTurnBusy } from './ai/chat-turn-lifecycle.js'

/** A declared environment and, when the chat's session is loaded, whether it is connected. */
export type ChatEnvironment = DeclaredEnvironment & { connected?: boolean }

type ChatRow = { sessionId?: string | null; metadata?: ChatMetadata }

const changing = new Set<number>()

export function guardEnvironmentChange(chatId: number) {
  if (changing.has(chatId)) throw new Error('The execution environments are being updated. Try again shortly.')
}

async function harness() {
  const { getOperonHarness } = await import('./operon-runtime/index.js')
  return getOperonHarness()
}

/** The chat's additional environments: its session's declaration, else the ones still to declare. */
export async function chatEnvironments(chat: ChatRow | undefined): Promise<DeclaredEnvironment[]> {
  if (!chat) return []
  if (chat.sessionId) return declaredEnvironments(await (await harness()).readEnvironmentDeclaration(chat.sessionId))
  return declareEnvironments(chat.metadata?.additionalSshEnvironments ?? [])
}

/** `chatEnvironments` with the live connection state, when the session is loaded. */
export async function listChatEnvironments(chat: ChatRow | undefined): Promise<ChatEnvironment[]> {
  const environments = await chatEnvironments(chat)
  const session = chat?.sessionId ? (await harness()).getSession(chat.sessionId) : undefined
  if (!session) return environments
  return environments.map(env => ({ ...env, connected: session.core.environments.get(env.target)?.available ?? false }))
}

/** The session now declares what the chat asked for: drop the request. */
export function clearPendingEnvironments(storage: Pick<ChatStorageAdapter, 'getChatMeta' | 'updateChatMetadata'>, chatId: number) {
  const metadata = storage.getChatMeta(chatId)?.metadata
  if (!metadata?.additionalSshEnvironments) return
  const { additionalSshEnvironments: _consumed, ...rest } = metadata
  storage.updateChatMetadata(chatId, rest)
}

/**
 * Attach (`add`) or detach environment `id` (a saved SSH profile, or `local` for a directory on
 * this machine). Adding one that is declared but disconnected connects it again.
 */
export async function changeChatEnvironment(
  storage: Pick<ChatStorageAdapter, 'getChatMeta' | 'updateChatMetadata'>,
  chatId: number,
  id: string,
  add: boolean,
  localDir?: string,
): Promise<ChatEnvironment[]> {
  guardEnvironmentChange(chatId)
  if (isChatTurnBusy(chatId)) throw new Error('You can change environments after this response.')
  const chat = storage.getChatMeta(chatId)
  if (!chat || chat.providerId !== 'custom' || chat.tp !== 'chat') throw new Error('An Operon conversation is required.')
  const rootId = chat.metadata?.sshEnvironment?.id
  if (id === rootId) throw new Error('The default environment is fixed after the first message.')
  changing.add(chatId)
  try {
    const refFor = (cwd?: string) => id === 'local'
      ? localRef(rootId, localDir ?? cwd)
      : { id, name: getSshEnvironment(id).name, ...(cwd ? { cwd } : {}) }

    if (!chat.sessionId) {
      const pending = chat.metadata?.additionalSshEnvironments ?? []
      const known = pending.some(ref => ref.id === id)
      if (add && known) return declareEnvironments(pending)
      if (add && id !== 'local') {
        // Nothing holds the connection yet: only check that it can be made.
        const { environment } = await connectSshEnvironment(getSshEnvironment(id))
        void environment.close().catch(console.warn)
      }
      const next = add ? [...pending, refFor()] : pending.filter(ref => ref.id !== id)
      storage.updateChatMetadata(chatId, { ...storage.getChatMeta(chatId)?.metadata, additionalSshEnvironments: next })
      return declareEnvironments(next)
    }

    const host = await harness()
    const session = host.getSession(chat.sessionId) ?? await host.resumeSession(chat.sessionId)
    const declared = declaredEnvironments(await host.readEnvironmentDeclaration(chat.sessionId))
    const current = declared.find(env => env.id === id)
    if (!add) {
      if (current) await session.updateEnvironments({ remove: [current.target] })
    } else if (!current || !session.core.environments.get(current.target)?.available) {
      // A declared but disconnected one is replaced under its own name, so the model's `target` holds.
      const [entry] = current
        ? [{ ...refFor(current.cwd), target: current.target }]
        : declareEnvironments([refFor()], session.core.environments.names)
      await session.updateEnvironments({
        ...(current && { remove: [current.target] }),
        add: { [entry.target]: environmentBinding(entry) },
      })
    }
    return listChatEnvironments(chat)
  } finally {
    changing.delete(chatId)
  }
}
