export interface SessionConfig {
  providerId: string
  modelId?: string
  modeId?: string
  workspaceId: number
}

export interface SessionConfigStore {
  get(channelKey: string): SessionConfig | undefined
  set(channelKey: string, config: SessionConfig): void
  update(channelKey: string, patch: Partial<SessionConfig>): void
  delete(channelKey: string): void
}

export function createSessionConfigStore(): SessionConfigStore {
  const map = new Map<string, SessionConfig>()
  return {
    get: (k) => map.get(k),
    set: (k, config) => { map.set(k, config) },
    update: (k, patch) => {
      const existing = map.get(k)
      if (existing) map.set(k, { ...existing, ...patch })
    },
    delete: (k) => { map.delete(k) },
  }
}
