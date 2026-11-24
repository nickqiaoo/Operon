import { useEffect } from "react"
import { watchPendingInput } from "@/lib/live-turn-events"

/**
 * One app-level watch of what every conversation is waiting on a person for.
 * The shell outlives any chat panel, and a background tab — or an external
 * agent's child chat nobody has opened — must still show that it is blocked.
 * `nodeId` set: another machine's, while a tab shows one of its chats.
 */
export function PendingInputSync({ nodeId }: { nodeId?: string } = {}) {
  useEffect(() => watchPendingInput(nodeId), [nodeId])
  return null
}
