import type { IMStorageAdapter } from '../../storage/interface.js'
import type { IMProviderMode, IMProviderRecord, IMSource } from '../../types/im.js'
import type { IMProvider } from './types.js'

export interface SelfIndexEntry {
  providerId: number
  agentId: number | null
}

export interface ProviderFactory {
  readonly source: IMSource
  create(record: IMProviderRecord): IMProvider
}

/**
 * Mode consumer: attaches to a provider after it starts. Each mode
 * (mate / interactive) has exactly one consumer; `attach` returns a
 * disposer invoked on stopOne to unhook the provider.
 */
export interface ModeConsumer {
  attach(provider: IMProvider): () => void
}

interface ActiveProvider {
  provider: IMProvider
  dispose: () => void
}

export class IMProviderRegistry {
  private factories = new Map<IMSource, ProviderFactory>()
  private active = new Map<number, ActiveProvider>()
  private selfIndex = new Map<string, SelfIndexEntry>()
  private consumers = new Map<IMProviderMode, ModeConsumer>()

  constructor(private storage: IMStorageAdapter) {}

  register(factory: ProviderFactory): void {
    this.factories.set(factory.source, factory)
  }

  setModeConsumer(mode: IMProviderMode, consumer: ModeConsumer): void {
    this.consumers.set(mode, consumer)
  }

  getProvider(id: number): IMProvider | undefined {
    return this.active.get(id)?.provider
  }

  getProviderByAgent(agentId: number): IMProvider | undefined {
    for (const a of this.active.values()) {
      if (a.provider.agentId === agentId) return a.provider
    }
    return undefined
  }

  getSelfIndex(): Map<string, SelfIndexEntry> {
    return this.selfIndex
  }

  async startAll(): Promise<void> {
    const records = this.storage.listIMProviders({ enabled: true })
    for (const record of records) {
      await this.startOne(record).catch((err) => {
        console.error(`[IMRegistry] start failed for provider ${record.source}:${record.instanceId}:`, err)
      })
    }
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.active.values())
    this.active.clear()
    this.selfIndex.clear()
    await Promise.allSettled(entries.map(async (a) => {
      try { a.dispose() } catch { /* ignore */ }
      await a.provider.stop()
    }))
  }

  async startOne(record: IMProviderRecord): Promise<IMProvider | null> {
    const existing = this.active.get(record.id)
    if (existing) return existing.provider

    const factory = this.factories.get(record.source)
    if (!factory) throw new Error(`No IMProvider factory registered for source=${record.source}`)

    const consumer = this.consumers.get(record.mode)
    if (!consumer) {
      console.warn(
        `[IMRegistry] no consumer for mode=${record.mode}; skipping ${record.source}:${record.instanceId}`,
      )
      return null
    }

    const provider = factory.create(record)
    const indexEntry: SelfIndexEntry = { providerId: record.id, agentId: record.agentId }

    // Seed selfIndex from DB (valid on the 2nd+ boot — first boot populates DB below).
    const seeded: string[] = []
    if (record.selfUserId) {
      const key = `${record.source}:${record.selfUserId}`
      this.selfIndex.set(key, indexEntry)
      seeded.push(key)
    }
    if (record.selfBotId) {
      const key = `${record.source}:${record.selfBotId}`
      this.selfIndex.set(key, indexEntry)
      seeded.push(key)
    }
    if (seeded.length > 0) {
      console.log(`[IMRegistry] seeded selfIndex for ${record.source}:${record.instanceId} → ${seeded.join(', ')}`)
    }

    const dispose = consumer.attach(provider)
    this.active.set(record.id, { provider, dispose })

    try {
      await provider.start()
    } catch (err) {
      this.active.delete(record.id)
      try { dispose() } catch { /* ignore */ }
      if (record.selfUserId) this.selfIndex.delete(`${record.source}:${record.selfUserId}`)
      if (record.selfBotId) this.selfIndex.delete(`${record.source}:${record.selfBotId}`)
      throw err
    }

    // First boot, or rotation: start() populated real self IDs via auth.test/getMe.
    // Persist so the next boot seeds selfIndex correctly, and re-index now.
    const userIdChanged = provider.selfUserId && provider.selfUserId !== record.selfUserId
    const botIdChanged = (provider.selfBotId ?? null) !== (record.selfBotId ?? null)
    if (userIdChanged || botIdChanged) {
      this.storage.updateIMProvider(record.id, {
        selfUserId: provider.selfUserId,
        selfBotId: provider.selfBotId,
      })
      if (userIdChanged) {
        if (record.selfUserId) this.selfIndex.delete(`${record.source}:${record.selfUserId}`)
        this.selfIndex.set(`${record.source}:${provider.selfUserId}`, indexEntry)
      }
      if (botIdChanged) {
        if (record.selfBotId) this.selfIndex.delete(`${record.source}:${record.selfBotId}`)
        if (provider.selfBotId) {
          this.selfIndex.set(`${record.source}:${provider.selfBotId}`, indexEntry)
        }
      }
      console.log(
        `[IMRegistry] persisted self ids for ${record.source}:${record.instanceId} ` +
        `(user=${provider.selfUserId}${provider.selfBotId ? ` bot=${provider.selfBotId}` : ''})`,
      )
    }

    // selfUsername is populated by provider.start() (Telegram getMe / Slack
    // auth.test → null). Not persisted: the next boot re-derives it during
    // start() before any messages can arrive on the fresh transport, so the
    // brief unindexed window doesn't exist in practice.
    if (provider.selfUsername) {
      this.selfIndex.set(`${record.source}:${provider.selfUsername}`, indexEntry)
    }

    return provider
  }

  async stopOne(providerId: number): Promise<void> {
    const entry = this.active.get(providerId)
    if (!entry) return
    this.active.delete(providerId)
    try { entry.dispose() } catch { /* ignore */ }
    this.selfIndex.delete(`${entry.provider.source}:${entry.provider.selfUserId}`)
    if (entry.provider.selfBotId) {
      this.selfIndex.delete(`${entry.provider.source}:${entry.provider.selfBotId}`)
    }
    if (entry.provider.selfUsername) {
      this.selfIndex.delete(`${entry.provider.source}:${entry.provider.selfUsername}`)
    }
    await entry.provider.stop()
  }
}
