/**
 * One-function indirections so the Electron main process can reach the Computer
 * Use engine without importing the route module that owns it, and the engine can
 * reach Electron without the server importing `electron`.
 *
 * `node-repl-mcp.ts` holds the shared cua-driver daemon, but it is a Hono router
 * and pulling it into `electron/main.ts` would drag the whole HTTP layer into
 * the main chunk. It registers its stopper here instead, and main calls this.
 *
 * The other direction is the host permission bridge below. The server never
 * imports `electron` (it also runs headless), so main registers the two calls
 * that need Electron APIs and the server asks through here.
 *
 * This file used to also carry the Swift engine's presentation event stream,
 * which drove the PiP preview window. cua-driver emits no such events — its
 * visible feedback is the agent-cursor overlay it draws itself — so that half
 * was removed along with the Swift wiring.
 */
type StopComputerUseService = () => Promise<void>

let stopComputerUseService: StopComputerUseService | undefined

export function setComputerUseServiceStopHandler(handler: StopComputerUseService): void {
  stopComputerUseService = handler
}

export async function stopComputerUseEngine(): Promise<void> {
  await stopComputerUseService?.()
}

export type ComputerUsePermissionKind = 'accessibility' | 'screenRecording'

/**
 * macOS grants as the host app sees them, and the way to ask for one.
 *
 * The daemon runs embedded: it is spawned directly by the app, so macOS
 * attributes it to the app and it answers TCC checks with the app's grants. The
 * flip side is that embedded cua-driver never raises a consent dialog —
 * `check_permissions {prompt: true}` is ignored — so the request has to come from
 * the app process itself.
 */
export interface ComputerUseHostPermissions {
  status(): { accessibility: boolean; screenRecording: boolean }
  request(permission: ComputerUsePermissionKind): Promise<void>
}

let hostPermissions: ComputerUseHostPermissions | undefined

export function setComputerUseHostPermissions(bridge: ComputerUseHostPermissions): void {
  hostPermissions = bridge
}

/** Undefined when no desktop host registered one, i.e. a headless server. */
export function getComputerUseHostPermissions(): ComputerUseHostPermissions | undefined {
  return hostPermissions
}
