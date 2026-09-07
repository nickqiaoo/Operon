/**
 * A one-function indirection so the Electron main process can stop the Computer
 * Use engine on quit without importing the route module that owns it.
 *
 * `node-repl-mcp.ts` holds the shared cua-driver daemon, but it is a Hono router
 * and pulling it into `electron/main.ts` would drag the whole HTTP layer into
 * the main chunk. It registers its stopper here instead, and main calls this.
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
