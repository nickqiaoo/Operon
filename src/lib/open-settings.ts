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
  /** A tab id from `SettingsPage`'s list — e.g. `plugins`, `extensions`, `mcp`. */
  tab: string
}

export function openSettingsTab(tab: string): void {
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { tab } }))
}
