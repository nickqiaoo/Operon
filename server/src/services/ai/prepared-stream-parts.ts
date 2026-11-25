import type { RuntimeInjectedInputPart, RuntimeTextStreamPart } from '@operon/agent-runtime'

/** A runtime part normalized for the UI stream, inside `runAgentTurn`. */
export type PreparedTextStreamPart<METADATA = Record<string, unknown> | undefined> = {
  part?: RuntimeTextStreamPart
  metadata?: METADATA
  /** A mid-turn message reached the agent here; rendered as a part of the reply. */
  injectedInput?: RuntimeInjectedInputPart
}
