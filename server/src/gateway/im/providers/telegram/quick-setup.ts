/**
 * Telegram Quick Setup helpers — one-shot Bot API calls for the
 * "user pastes a fresh BotFather token, we configure the rest" flow.
 *
 * Uses raw fetch instead of gramio's Bot class: these are stateless
 * validate/configure operations that shouldn't spin up a polling
 * connection. The Bot instance is created later when the IM provider
 * row is started by the registry.
 */

const TG_BASE = 'https://api.telegram.org'

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function callBotApi<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json()) as TelegramApiResponse<T>
  if (!data.ok || data.result === undefined) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`)
  }
  return data.result
}

export interface TelegramBotInfo {
  id: number
  isBot: boolean
  username: string | null
  firstName: string
  canJoinGroups?: boolean
  canReadAllGroupMessages?: boolean
  supportsInlineQueries?: boolean
}

/** Validate a freshly-pasted bot token by calling getMe. */
export async function validateBotToken(token: string): Promise<TelegramBotInfo> {
  interface GetMeResult {
    id: number
    is_bot: boolean
    username?: string
    first_name: string
    can_join_groups?: boolean
    can_read_all_group_messages?: boolean
    supports_inline_queries?: boolean
  }
  const me = await callBotApi<GetMeResult>(token, 'getMe')
  if (!me.is_bot) {
    throw new Error('Token does not belong to a bot account')
  }
  return {
    id: me.id,
    isBot: me.is_bot,
    username: me.username ?? null,
    firstName: me.first_name,
    canJoinGroups: me.can_join_groups,
    canReadAllGroupMessages: me.can_read_all_group_messages,
    supportsInlineQueries: me.supports_inline_queries,
  }
}

export interface ApplyBotDefaultsInput {
  /** Telegram bot display name (max 64 chars per Bot API). */
  displayName: string
  /** Long description shown in the profile page. */
  description?: string
  /** Short description shown next to the bot in the contact list. */
  shortDescription?: string
}

/**
 * Apply our default bot configuration after Quick Setup. Each step is
 * best-effort — Telegram occasionally returns "not modified" / 400 on
 * idempotent re-runs, which we treat as success.
 *
 * Default admin rights are set to a permissive baseline so that when a
 * user adds the bot to a group, they can promote it to admin in one tap
 * (and that admin role bypasses privacy mode — the practical workaround
 * for the BotFather-only `/setprivacy` toggle).
 */
export async function applyBotDefaults(token: string, input: ApplyBotDefaultsInput): Promise<void> {
  const name = input.displayName.slice(0, 64)
  await callBotApi(token, 'setMyName', { name }).catch(absorbBenign)

  if (input.description != null) {
    const desc = input.description.slice(0, 512)
    await callBotApi(token, 'setMyDescription', { description: desc }).catch(absorbBenign)
  }
  if (input.shortDescription != null) {
    const short = input.shortDescription.slice(0, 120)
    await callBotApi(token, 'setMyShortDescription', { short_description: short }).catch(absorbBenign)
  }

  await callBotApi(token, 'setMyCommands', {
    commands: [
      { command: 'stop', description: 'Stop the current task' },
      { command: 'reset', description: 'Reset the conversation' },
    ],
  }).catch(absorbBenign)

  // Permissive default admin rights — user can confirm or pare down in
  // the per-group admin prompt. We do NOT set is_anonymous / can_manage_chat
  // higher than needed: this is just the recommendation Telegram shows the
  // user when they promote the bot.
  await callBotApi(token, 'setMyDefaultAdministratorRights', {
    rights: {
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: false,
      can_manage_video_chats: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: true,
      can_post_messages: false,
      can_edit_messages: false,
      can_pin_messages: true,
    },
    for_channels: false,
  }).catch(absorbBenign)
}

/**
 * Swallow expected idempotent failures (e.g. setMyName when value is unchanged
 * returns "name is not modified"). Re-throw the rest so the caller can surface
 * real configuration problems to the user.
 */
function absorbBenign(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('not modified') || msg.includes('NAME_NOT_MODIFIED')) return
  throw err
}
