// What chat sessions do between turns, routed onto the chat.
//
// `SessionManager.setBackgroundHandler` delivers two kinds of event from a
// session no request is streaming:
//
// - `tasks`: its background sub-agents changed. Kept per chat for the
//   live-status stream, which the sub-agent cards read.
// - `turn`: the agent started a reply on its own (Claude Code answering a
//   background agent that finished). Run as a detached turn — streamed to any
//   open tab and persisted — and announced like a reply the user asked for.

import type { RuntimeBackgroundEvent, RuntimeStreamPart } from '@operon/agent-runtime'
import type { SubagentTranscript } from '../../../../shared/background-tasks.js'
import { notify } from '../notification-service.js'
import { setChatBackgroundTasks } from './chat-background-tasks.js'
import { observePendingInputPart } from './chat-pending-input.js'
import { replySnippet, runDetachedTurn } from './detached-turn.js'
import { getChatHistoryService, getNotificationStorage, getRuntime, getSessionManager } from './state.js'

export function handleRuntimeBackgroundEvent(chatId: number, event: RuntimeBackgroundEvent): void {
  if (event.type === 'tasks') {
    setChatBackgroundTasks(chatId, event.tasks)
    return
  }
  runAgentStartedTurn(chatId, event.parts).catch((error: unknown) => {
    console.error(`[AI] agent-started turn on chat ${chatId} failed:`, error)
  })
}

async function runAgentStartedTurn(chatId: number, parts: AsyncIterable<RuntimeStreamPart>): Promise<void> {
  const meta = chatId > 0 ? getChatHistoryService()?.getChatMeta(chatId) : undefined
  if (!meta) {
    // Nowhere to put it (a standalone session). Drain so the runtime never blocks.
    for await (const _ of parts) {
      // discard
    }
    return
  }

  const message = await runDetachedTurn(
    {
      chatId,
      modelId: meta.model,
      providerId: meta.providerId,
      sessionId: meta.sessionId,
      logTag: 'AI',
      // It can stop for an approval like any turn; the tab marker and inbox
      // should say so.
      onPart: (part) => observePendingInputPart(chatId, part, { userFacing: meta.tp === 'chat' }),
    },
    parts,
  )

  // Same rule as handleChat: only the user's own conversations reach the inbox.
  const storage = getNotificationStorage()
  if (!message || !storage || meta.tp !== 'chat') return
  notify(storage, {
    kind: 'chat_complete',
    severity: 'info',
    sourceKey: `chat:${chatId}`,
    chatId,
    workspaceId: meta.workspaceId ?? null,
    title: meta.title?.trim() || 'Workspace chat',
    body: replySnippet(message) ?? 'Agent finished responding',
  })
}

/**
 * The steps of the sub-agent a chat's `Agent` call `toolUseId` spawned, read from
 * Claude Code's own transcript of it. A background agent's steps never reach the
 * chat's messages, and this outlives the process that ran it. Null when the chat
 * has no Claude session or no such sub-agent.
 */
export async function getSubagentTranscript(chatId: number, toolUseId: string): Promise<SubagentTranscript | null> {
  // The live session knows its id before the chat row does (that is written as
  // the turn ends).
  const sessionId =
    getSessionManager().get(chatId)?.runtime.getSessionId?.() ??
    getChatHistoryService()?.getChatMeta(chatId)?.sessionId
  if (!sessionId) return null
  return getRuntime().native('claude-code').subagentTranscript(sessionId, toolUseId)
}
