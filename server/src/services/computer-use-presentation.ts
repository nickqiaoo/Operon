import type { ComputerUsePresentationEvent } from '@operon/computer-use'

type PresentationSink = (event: ComputerUsePresentationEvent) => void
type EndHostSession = (hostSessionID: string) => Promise<void>
type StopComputerUseService = () => Promise<void>

let sink: PresentationSink | undefined
let endHostSession: EndHostSession | undefined
let stopComputerUseService: StopComputerUseService | undefined
const activeHostSessions = new Set<string>()

export function setComputerUsePresentationSink(next: PresentationSink | undefined): void {
  sink = next
}

export function publishComputerUsePresentationEvent(
  event: ComputerUsePresentationEvent,
): void {
  if (event.type === 'ended') {
    if (event.hostSessionID) activeHostSessions.delete(event.hostSessionID)
    else activeHostSessions.clear()
  } else if (event.hostSessionID) {
    activeHostSessions.add(event.hostSessionID)
  }
  sink?.(event)
}

export function setComputerUseEndHostSessionHandler(handler: EndHostSession): void {
  endHostSession = handler
}

export function setComputerUseServiceStopHandler(handler: StopComputerUseService): void {
  stopComputerUseService = handler
}

export async function stopComputerUsePresentationService(): Promise<void> {
  await stopComputerUseService?.()
}

export async function endComputerUseHostSession(hostSessionID: string): Promise<void> {
  if (!activeHostSessions.has(hostSessionID)) return
  try {
    await endHostSession?.(hostSessionID)
  } finally {
    activeHostSessions.delete(hostSessionID)
    sink?.({ type: 'ended', hostSessionID, reason: 'turn-ended' })
  }
}
