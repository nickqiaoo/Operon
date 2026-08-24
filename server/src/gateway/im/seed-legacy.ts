import type { StorageAdapter, IMStorageAdapter } from '../../storage/interface.js'

type Storage = StorageAdapter & IMStorageAdapter

const KV_SLACK_BOT = 'slack:bot_token'
const KV_SLACK_APP = 'slack:app_token'
const KV_SLACK_CONFIG = 'slack:config'
const KV_TG_BOT = 'telegram:bot_token'
const KV_TG_CONFIG = 'telegram:config'

/**
 * One-time migration: lift legacy KV-stored Slack/Telegram tokens into the
 * `im_providers` table as interactive-mode rows so the new IM registry can
 * manage them. Idempotent — if a row with the same credentials already
 * exists, the KV entry is cleared and nothing else happens.
 *
 * Runs on every boot; no-ops after the first successful seed.
 */
export function seedLegacyIMTokens(storage: Storage): void {
  seedSlack(storage)
  seedTelegram(storage)
}

function seedSlack(storage: Storage): void {
  const botToken = storage.get<string>(KV_SLACK_BOT)
  const appToken = storage.get<string>(KV_SLACK_APP)
  if (!botToken || !appToken) return

  const existing = storage
    .listIMProviders({ source: 'slack' })
    .find((p) => tokensMatch(p.credentialsJson, { botToken, appToken }))

  if (!existing) {
    const extra =
      storage.get<{ allowedUserIds?: string[]; allowedChannelIds?: string[] }>(KV_SLACK_CONFIG) ?? {}
    const configJson =
      (extra.allowedUserIds?.length ?? 0) + (extra.allowedChannelIds?.length ?? 0) > 0
        ? JSON.stringify({
            allowedUserIds: extra.allowedUserIds ?? [],
            allowedChannelIds: extra.allowedChannelIds ?? [],
          })
        : null

    storage.createIMProvider({
      source: 'slack',
      instanceId: 'legacy',
      mode: 'interactive',
      agentId: null,
      selfUserId: '',
      selfBotId: null,
      displayName: 'Slack (legacy)',
      credentialsJson: JSON.stringify({ botToken, appToken }),
      configJson,
      enabled: true,
    })
    console.log('[IM:seed] Migrated legacy Slack token → im_providers (interactive)')
  }

  storage.delete(KV_SLACK_BOT)
  storage.delete(KV_SLACK_APP)
  storage.delete(KV_SLACK_CONFIG)
}

function seedTelegram(storage: Storage): void {
  const botToken = storage.get<string>(KV_TG_BOT)
  if (!botToken) return

  const existing = storage
    .listIMProviders({ source: 'telegram' })
    .find((p) => tokensMatch(p.credentialsJson, { botToken }))

  if (!existing) {
    const extra = storage.get<{ allowedUserIds?: number[] }>(KV_TG_CONFIG) ?? {}
    const configJson = extra.allowedUserIds?.length
      ? JSON.stringify({ allowedUserIds: extra.allowedUserIds })
      : null

    storage.createIMProvider({
      source: 'telegram',
      instanceId: 'legacy',
      mode: 'interactive',
      agentId: null,
      selfUserId: '',
      selfBotId: null,
      displayName: 'Telegram (legacy)',
      credentialsJson: JSON.stringify({ botToken }),
      configJson,
      enabled: true,
    })
    console.log('[IM:seed] Migrated legacy Telegram token → im_providers (interactive)')
  }

  storage.delete(KV_TG_BOT)
  storage.delete(KV_TG_CONFIG)
}

function tokensMatch(
  credentialsJson: string,
  expected: { botToken: string; appToken?: string },
): boolean {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>
    const bot = parsed.botToken ?? parsed.bot_token
    const app = parsed.appToken ?? parsed.app_token
    if (bot !== expected.botToken) return false
    if (expected.appToken !== undefined && app !== expected.appToken) return false
    return true
  } catch {
    return false
  }
}
