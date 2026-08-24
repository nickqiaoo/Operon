export interface RecentChatOptions {
  modelId?: string
  modeId?: string
  thinkingEffort?: string
  serviceTier?: string
}

const STORAGE_KEY = "operon.chat.recent-options:v1"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const parseOptions = (value: unknown): RecentChatOptions | undefined => {
  if (!isRecord(value)) return undefined

  const options: RecentChatOptions = {
    modelId: readString(value.modelId),
    modeId: readString(value.modeId),
    thinkingEffort: readString(value.thinkingEffort),
    serviceTier: readString(value.serviceTier),
  }

  return Object.values(options).some((option) => option !== undefined)
    ? options
    : undefined
}

const readAll = (): Record<string, RecentChatOptions> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}

    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}

    const result: Record<string, RecentChatOptions> = {}
    for (const [providerId, value] of Object.entries(parsed)) {
      const options = parseOptions(value)
      if (options) result[providerId] = options
    }
    return result
  } catch {
    return {}
  }
}

export function getRecentChatOptions(providerId: string | undefined): RecentChatOptions {
  if (!providerId) return {}
  return readAll()[providerId] ?? {}
}

export function updateRecentChatOptions(
  providerId: string | undefined,
  patch: RecentChatOptions,
): void {
  if (!providerId) return

  try {
    const allOptions = readAll()
    allOptions[providerId] = {
      ...allOptions[providerId],
      ...patch,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allOptions))
  } catch {
    // localStorage can be unavailable or full. Preferences are non-essential.
  }
}
