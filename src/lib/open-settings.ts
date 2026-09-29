/**
 * Open Settings on a given tab, from anywhere.
 *
 * Settings is owned by `App`, and the components that most want to send you there — a
 * plugin row in the session panel, an extension row — sit at the bottom of a long prop
 * chain (App → EditorArea → ChatPanel → AgentPanel). Threading a callback down that far
 * for one navigation is worse than an event: it makes every component in between know
 * about Settings. The same pattern already carries browser history changes and node
 * offline notices (`serverHistory.ts`, `web-auth.ts`).
 */
export const OPEN_SETTINGS_EVENT = 'operon:open-settings'

export interface OpenSettingsDetail {
  /** A tab id from `SettingsPage`'s list — e.g. `skills`, `extensions`, `mcp`. */
  tab: string
}

export function openSettingsTab(tab: string): void {
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { tab } }))
}

/**
 * Open the Plugins page, optionally on one plugin's detail view (e.g. from a skill or MCP server a
 * plugin provides). Plugins is a full page owned by `App`, like Settings, so it's reached the same
 * way — by event. The id is parked here rather than threaded through: a freshly mounted Plugins
 * page picks it up on mount, an already-open one hears `OPEN_PLUGIN_EVENT`.
 */
export const OPEN_PLUGINS_PAGE_EVENT = 'operon:open-plugins-page'
export const OPEN_PLUGIN_EVENT = 'operon:open-plugin'
let pendingPluginId: string | null = null

export function openPluginsPage(pluginId?: string): void {
  if (pluginId) pendingPluginId = pluginId
  window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_PAGE_EVENT))
  if (pluginId) window.dispatchEvent(new CustomEvent<string>(OPEN_PLUGIN_EVENT, { detail: pluginId }))
}

/** Read and clear the plugin a caller asked the Plugins page to open. */
export function consumePendingPluginId(): string | null {
  const id = pendingPluginId
  pendingPluginId = null
  return id
}

/**
 * Open the Schedule page, optionally with one task selected (e.g. from the card a
 * `schedule_create` call renders in a chat). Same shape as the Plugins page: the id is
 * parked here and picked up by the page when it mounts.
 */
export const OPEN_SCHEDULE_PAGE_EVENT = 'operon:open-schedule-page'
let pendingCronjobId: number | null = null

export function openSchedulePage(cronjobId?: number): void {
  if (cronjobId != null) pendingCronjobId = cronjobId
  window.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_PAGE_EVENT))
}

/** Read and clear the task a caller asked the Schedule page to select. */
export function consumePendingCronjobId(): number | null {
  const id = pendingCronjobId
  pendingCronjobId = null
  return id
}
