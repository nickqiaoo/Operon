import { useNavigationStore } from "@/stores/navigation-store"

/**
 * Open Settings on a given tab, from anywhere.
 *
 * The components that most want to send you there — a plugin row in the session panel, an
 * extension row — sit at the bottom of a long prop chain (App → EditorArea → ChatPanel →
 * AgentPanel). Threading a callback down that far for one navigation would make every component
 * in between know about Settings, so these helpers go to the navigation store directly.
 */
export function openSettingsTab(tab: string): void {
  useNavigationStore.getState().openPage({ kind: "settings", tab })
}

/**
 * Open the Plugins page, optionally on one plugin's detail view (e.g. from a skill or MCP server a
 * plugin provides). It opens on top of Settings when called from there, so Back lands where the
 * user came from. Already open, it is brought to the top and switches to that plugin.
 */
export function openPluginsPage(pluginId?: string): void {
  useNavigationStore.getState().openPage({ kind: "plugins", pluginId })
}

/**
 * Open the Schedule page, optionally with one task selected (e.g. from the card a
 * `schedule_create` call renders in a chat).
 */
export function openSchedulePage(cronjobId?: number): void {
  useNavigationStore.getState().openPage({ kind: "schedule", cronjobId })
}
