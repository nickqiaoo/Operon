import type { HarnessSession } from 'operon-agents'
import type { SshEnvironment } from 'operon-agents/advanced'
import type { ChatStorageAdapter } from '../storage/interface.js'
import { additionalSshBinding, connectSshEnvironment, getSshEnvironment, releaseSshTarget, localRef, sshTarget } from './ssh-environments.js'
import { isChatTurnBusy } from './ai/chat-turn-lifecycle.js'

const changing = new Set<number>()
const liveConnections = new WeakMap<HarnessSession, Set<SshEnvironment>>()

export function guardEnvironmentChange(chatId: number) {
  if (changing.has(chatId)) throw new Error('The execution environments are being updated. Try again shortly.')
}

export function releaseAddedEnvironments(session: HarnessSession) {
  const connections = liveConnections.get(session)
  connections?.forEach(releaseSshTarget)
  liveConnections.delete(session)
}

export async function changeChatEnvironment(storage: Pick<ChatStorageAdapter, 'getChatMeta' | 'updateChatMetadata'>, chatId: number, id: string, add: boolean, localDir?: string) {
  guardEnvironmentChange(chatId)
  if (isChatTurnBusy(chatId)) throw new Error('You can change environments after this response.')
  const chat = storage.getChatMeta(chatId)
  if (!chat || chat.providerId !== 'custom' || chat.tp !== 'chat') throw new Error('An Operon conversation is required.')
  if (id === chat.metadata?.sshEnvironment?.id) throw new Error('The default environment is fixed after the first message.')
  changing.add(chatId)
  try {
    const refs = chat.metadata?.additionalSshEnvironments ?? []
    const name = sshTarget(id)
    let session: HarnessSession | undefined
    if (chat.sessionId) {
      const { getOperonHarness } = await import('./operon-runtime/index.js')
      const harness = await getOperonHarness()
      session = harness.getSession(chat.sessionId) ?? await harness.resumeSession(chat.sessionId)
    }
    const current = session?.core.environments.get(name)
    const known = refs.find(ref => ref.id === id)
    const save = (next: typeof refs) => storage.updateChatMetadata(chatId, {
      ...storage.getChatMeta(chatId)?.metadata, additionalSshEnvironments: next,
    })
    if (!add) {
      const next = refs.filter(item => item.id !== id)
      // Persist removal first. After an interrupted update a declared target without a binding
      // can still be restored. The inverse (binding without a declaration) cannot.
      save(next)
      if (session && current) {
        try {
          await session.updateEnvironments({ remove: [name] })
        } catch (error) {
          save(refs)
          throw error
        }
        releaseSshTarget(current.environment)
      }
      return next
    }
    const ref = known ?? (id === 'local'
      ? localRef(chat.metadata?.sshEnvironment?.id, localDir)
      : { id, name: getSshEnvironment(id).name })
    if (session && !current?.available) {
      const owned = liveConnections.get(session) ?? new Set<SshEnvironment>()
      liveConnections.set(session, owned)
      const before = new Set(owned)
      try {
        await session.updateEnvironments({
          ...(current && { remove: [name] }),
          add: { [name]: additionalSshBinding(ref, owned) },
        })
      } catch (error) {
        for (const env of owned) if (!before.has(env)) releaseSshTarget(env)
        throw error
      }
    } else if (!session && id !== 'local') {
      const { environment } = await connectSshEnvironment(getSshEnvironment(ref.id))
      void environment.close().catch(console.warn)
    }
    if (known) return refs
    const additional = [...refs, ref]
    try {
      save(additional)
    } catch (error) {
      const opened = session?.core.environments.get(name)
      if (session && opened) {
        await session.updateEnvironments({ remove: [name] })
        releaseSshTarget(opened.environment)
      }
      throw error
    }
    return additional
  } finally {
    changing.delete(chatId)
  }
}
