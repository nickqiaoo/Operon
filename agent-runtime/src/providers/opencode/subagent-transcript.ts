import type { SessionMessageInfo } from '@opencode/client'
import type { RuntimeContext } from '../../context.js'
import { childSessionOf, OPENCODE_SUBAGENT_TOOLS } from './background-subagents.js'
import { OpencodeClientManager } from './client-manager.js'
import { stripOpencodeCallerArg } from './caller-identity.js'

/** One tool call a sub-agent made, shaped like a tool part (see `shared/background-tasks.ts`). */
export interface OpencodeSubagentStep {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  state: 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

export interface OpencodeSubagentTranscript {
  steps: OpencodeSubagentStep[]
  /** The sub-agent's session ran to completion. */
  finished: boolean
}

type AssistantMessage = Extract<SessionMessageInfo, { type: 'assistant' }>
type ToolBlock = Extract<AssistantMessage['content'][number], { type: 'tool' }>

function toolBlocks(messages: readonly SessionMessageInfo[]): ToolBlock[] {
  return messages.flatMap((message) =>
    message.type === 'assistant' ? message.content.filter((block): block is ToolBlock => block.type === 'tool') : [],
  )
}

function contentText(content: ReadonlyArray<{ type: string; text?: string; uri?: string }> | undefined): string {
  return (content ?? []).map((entry) => entry.text ?? entry.uri ?? '').join('\n')
}

/** The child session a parent's sub-agent call launched. */
function childOfCall(block: ToolBlock): string | undefined {
  const state = block.state
  if (state.status === 'streaming') return undefined
  const fromMetadata = childSessionOf('metadata' in state ? state.metadata : undefined)
  if (fromMetadata) return fromMetadata
  // Older servers only name it in the call's text result.
  const text = 'content' in state ? contentText(state.content) : ''
  return text.match(/sessionID:\s*(ses_[A-Za-z0-9]+)/)?.[1]
}

/** A sub-agent's steps, from its session's own history. */
export function opencodeSubagentTranscriptFrom(messages: readonly SessionMessageInfo[]): OpencodeSubagentTranscript {
  const steps = toolBlocks(messages).map((block): OpencodeSubagentStep => {
    const state = block.state
    const input = state.status === 'streaming' ? {} : stripOpencodeCallerArg(state.input) as Record<string, unknown>
    const base = { toolCallId: block.id, toolName: block.name === 'question' ? 'AskUserQuestion' : block.name, input }
    if (state.status === 'completed') return { ...base, state: 'output-available', output: contentText(state.content) }
    if (state.status === 'error') return { ...base, state: 'output-error', errorText: state.error.message }
    return { ...base, state: 'input-available' }
  })
  const last = messages.at(-1)
  return { steps, finished: last?.type === 'idle' && last.outcome === 'succeeded' }
}

/**
 * The steps of the sub-agent that call `toolUseId` in session `sessionId`
 * launched. A background sub-agent's steps arrive after the turn that launched
 * it, so they never reach that turn's message; its card reads them here. Null
 * when the call is not a sub-agent launch.
 */
export async function readOpencodeSubagentTranscript(
  ctx: RuntimeContext,
  sessionId: string,
  toolUseId: string,
): Promise<OpencodeSubagentTranscript | null> {
  const client = await OpencodeClientManager.getInstance(ctx, { autoStartServer: true }).getClient()
  const parent = await client.session.context({ sessionID: sessionId })
  const call = toolBlocks(parent).find((block) => block.id === toolUseId && OPENCODE_SUBAGENT_TOOLS.has(block.name))
  const child = call && childOfCall(call)
  if (!child) return null
  return opencodeSubagentTranscriptFrom(await client.session.context({ sessionID: child }))
}
