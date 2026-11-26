import type { ChatStorageAdapter } from '../storage/interface.js'
import type { AiChatRequest } from './ai/types.js'
import { ChatBusyError, runChatTurn } from './ai/chat-flow.js'
import { isChatTurnBusy } from './ai/chat-turn-lifecycle.js'
import { additionalSshRefs, getSshEnvironment } from './ssh-environments.js'

interface QueuedMessage {
  id: string
  chatId: number
  sendAt: number
  preview: string
  state: 'pending' | 'sending' | 'failed'
  payload: AiChatRequest
  error?: string
}

export class ScheduledMessages {
  private readonly messages = new Map<string, QueuedMessage>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private storage: Pick<ChatStorageAdapter, 'getChatMeta' | 'createChat'>,
    private enrich: (payload: AiChatRequest) => void,
  ) {}

  stop() {
    clearTimeout(this.timer)
    this.messages.clear()
  }

  enqueue(sendAt: number, payload: AiChatRequest) {
    const message = payload.messages[0]
    const previous = this.messages.get(message.id)
    if (previous) return { chatId: previous.chatId }
    if (payload.chatId !== undefined && !this.storage.getChatMeta(payload.chatId)) throw new Error('Conversation unavailable')
    const ssh = payload.sshEnvironmentId ? getSshEnvironment(payload.sshEnvironmentId) : undefined
    const additional = additionalSshRefs(payload.additionalSshEnvironmentIds, ssh?.id, payload.localEnvironmentCwd)
    const chatId = payload.chatId ?? this.storage.createChat({
      tp: payload.tp ?? 'chat', title: 'New chat', workspaceId: payload.workspaceId,
      providerId: payload.providerId, model: payload.modelId, updatedAt: Date.now(),
      metadata: ssh || additional.length ? { sshEnvironment: ssh && { id: ssh.id, name: ssh.name }, additionalSshEnvironments: additional } : undefined,
    })
    const preview = message.parts.map(p => p.type === 'text' ? p.text : p.type === 'file' ? p.filename || 'Attachment' : '').join(' ').trim().slice(0, 200)
    this.messages.set(message.id, {
      id: message.id, chatId, sendAt, preview, state: 'pending', payload: { ...payload, chatId },
    })
    this.arm()
    return { chatId }
  }

  list(chatId: number) {
    return [...this.messages.values()].filter(item => item.chatId === chatId)
      .sort((a, b) => b.sendAt - a.sendAt)
      .map(({ id, sendAt, preview, state, error }) => ({ id, sendAt, preview, state, error }))
  }

  cancel(chatId: number, id: string) {
    const item = this.messages.get(id)
    if (!item || item.chatId !== chatId || item.state === 'sending') return false
    this.messages.delete(id)
    this.arm()
    return true
  }

  private arm(minDelay = 0) {
    clearTimeout(this.timer)
    let earliest = Infinity
    for (const item of this.messages.values()) {
      if (item.state === 'pending') earliest = Math.min(earliest, item.sendAt)
    }
    if (Number.isFinite(earliest)) {
      this.timer = setTimeout(() => this.tick(), Math.max(minDelay, earliest - Date.now()))
      this.timer.unref()
    }
  }

  private tick() {
    const now = Date.now()
    const due = [...this.messages.values()].filter(item => item.state === 'pending' && item.sendAt <= now)
    for (const item of due.sort((a, b) => a.sendAt - b.sendAt)) {
      if (isChatTurnBusy(item.chatId)) continue
      item.state = 'sending'
      void this.deliver(item)
    }
    this.arm(500)
  }

  private async deliver(item: QueuedMessage) {
    try {
      if (!this.storage.getChatMeta(item.chatId)) {
        this.messages.delete(item.id)
        return
      }
      this.enrich(item.payload)
      await runChatTurn(item.payload, { admission: 'idle-only', userFacing: true, notifyInbox: true })
      this.messages.delete(item.id)
    } catch (error) {
      if (error instanceof ChatBusyError) {
        item.state = 'pending'
        this.arm(500)
      } else {
        item.state = 'failed'
        item.error = error instanceof Error ? error.message : String(error)
      }
    }
  }
}
