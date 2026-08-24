/**
 * Platform-agnostic askChoice state machine.
 *
 * Owns the pendingByNonce/pendingByChannel bookkeeping, pagination math, and
 * timeout/cancel rules so providers only supply a renderer (how to draw /
 * edit / finalize a single message on their platform) and route incoming
 * button events through `dispatch(actionId)`.
 */

import { randomUUID } from 'crypto'
import type { Choice } from './types.js'

const DEFAULT_PAGE_SIZE = 10
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface ChoiceButton {
  actionId: string
  label: string
  description?: string
}

export interface PageNav {
  current: number
  total: number
  prev?: { actionId: string }
  next?: { actionId: string }
}

export interface PageView {
  question: string
  choices: ChoiceButton[]
  nav?: PageNav
}

export interface ChoiceRenderer {
  send(view: PageView): Promise<string | undefined>
  edit(messageId: string, view: PageView): Promise<void>
  finalize(messageId: string, selectedLabel: string): Promise<void>
}

export interface ChoicePaginatorOptions {
  pageSize?: number
  defaultTimeoutMs?: number
}

interface PendingChoice {
  channelKey: string
  nonce: string
  question: string
  choices: Choice[]
  page: number
  resolve: (choiceId: string) => void
  reject: (err: Error) => void
  renderer: ChoiceRenderer
  messageId?: string
  timer: NodeJS.Timeout
}

export class ChoicePaginator {
  private readonly pageSize: number
  private readonly defaultTimeoutMs: number
  private readonly pendingByNonce = new Map<string, PendingChoice>()
  private readonly pendingByChannel = new Map<string, string>()

  constructor(options: ChoicePaginatorOptions = {}) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  start(
    channelKey: string,
    question: string,
    choices: Choice[],
    renderer: ChoiceRenderer,
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    this.cancel(channelKey, 'Cancelled by new request')

    const nonce = randomUUID().slice(0, 8)
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.evict(nonce)
        reject(new Error('askChoice timeout'))
      }, timeoutMs)

      const pending: PendingChoice = {
        channelKey, nonce, question, choices, page: 0,
        resolve, reject, renderer, timer,
      }
      this.pendingByNonce.set(nonce, pending)
      this.pendingByChannel.set(channelKey, nonce)

      const view = this.buildView(pending)
      renderer.send(view).then((messageId) => {
        const live = this.pendingByNonce.get(nonce)
        if (live) live.messageId = messageId
      }).catch((err) => {
        this.evict(nonce)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  cancel(channelKey: string, reason: string): void {
    const nonce = this.pendingByChannel.get(channelKey)
    if (!nonce) return
    const pending = this.pendingByNonce.get(nonce)
    this.evict(nonce)
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
  }

  async dispatch(actionId: string): Promise<'choice' | 'page' | 'unknown'> {
    const choiceMatch = actionId.match(/^c:([^:]+):(\d+)$/)
    if (choiceMatch) {
      return (await this.handleChoice(choiceMatch[1], parseInt(choiceMatch[2], 10))) ? 'choice' : 'unknown'
    }
    const pageMatch = actionId.match(/^cp:([^:]+):(\d+)$/)
    if (pageMatch) {
      return (await this.handlePage(pageMatch[1], parseInt(pageMatch[2], 10))) ? 'page' : 'unknown'
    }
    return 'unknown'
  }

  dispose(): void {
    for (const pending of this.pendingByNonce.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Provider stopped'))
    }
    this.pendingByNonce.clear()
    this.pendingByChannel.clear()
  }

  private async handleChoice(nonce: string, idx: number): Promise<boolean> {
    const pending = this.pendingByNonce.get(nonce)
    if (!pending) return false
    const choice = pending.choices[idx]
    if (!choice) return false

    this.evict(nonce)
    clearTimeout(pending.timer)

    if (pending.messageId) {
      await pending.renderer.finalize(pending.messageId, choice.label).catch(() => {})
    }
    pending.resolve(choice.id)
    return true
  }

  private async handlePage(nonce: string, page: number): Promise<boolean> {
    const pending = this.pendingByNonce.get(nonce)
    if (!pending) return false
    pending.page = page
    if (pending.messageId) {
      const view = this.buildView(pending)
      await pending.renderer.edit(pending.messageId, view).catch(() => {})
    }
    return true
  }

  private evict(nonce: string): void {
    const pending = this.pendingByNonce.get(nonce)
    if (!pending) return
    this.pendingByNonce.delete(nonce)
    if (this.pendingByChannel.get(pending.channelKey) === nonce) {
      this.pendingByChannel.delete(pending.channelKey)
    }
  }

  private buildView(pending: PendingChoice): PageView {
    const { choices, page, question, nonce } = pending
    const totalPages = Math.max(1, Math.ceil(choices.length / this.pageSize))
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const start = safePage * this.pageSize
    const slice = choices.slice(start, start + this.pageSize)

    const pageChoices: ChoiceButton[] = slice.map((c, i) => ({
      actionId: `c:${nonce}:${start + i}`,
      label: c.label,
      description: c.description,
    }))

    let nav: PageNav | undefined
    if (totalPages > 1) {
      nav = {
        current: safePage + 1,
        total: totalPages,
        prev: safePage > 0 ? { actionId: `cp:${nonce}:${safePage - 1}` } : undefined,
        next: safePage < totalPages - 1 ? { actionId: `cp:${nonce}:${safePage + 1}` } : undefined,
      }
    }

    return { question, choices: pageChoices, nav }
  }
}
