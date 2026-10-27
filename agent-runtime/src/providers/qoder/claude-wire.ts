import type * as Claude from '@anthropic-ai/claude-agent-sdk'
import type * as Qoder from '@qoder-ai/qoder-agent-sdk'

/**
 * The one place Qoder messages cross into Claude SDK types.
 *
 * qodercli speaks Claude Code's stream-json protocol: the same `stream_event`
 * (Anthropic raw stream events), `assistant`, `user` and `result` messages,
 * byte-for-byte (checked against a live qodercli 1.1.79 session). The Qoder SDK
 * ships its own copy of the Anthropic message types, though, a snapshot that
 * lacks a few optional-in-practice fields the Claude SDK's newer copy declares
 * required (`context_management`, `stop_details`, …). TypeScript sees two
 * unrelated types where the wire carries one, so the conversion is a type
 * assertion — kept here, per message kind, instead of at every call site.
 */

export const asClaudeStreamEvent = (message: Qoder.SDKPartialAssistantMessage) =>
  message as unknown as Claude.SDKPartialAssistantMessage

export const asClaudeAssistant = (message: Qoder.SDKAssistantMessage) =>
  message as unknown as Claude.SDKAssistantMessage

export const asClaudeUser = (message: Qoder.SDKUserMessage) => message as unknown as Claude.SDKUserMessage

export const asClaudeResult = (message: Qoder.SDKResultMessage) => message as unknown as Claude.SDKResultMessage

/** The other direction: a user message body built by the Claude prompt mapper. */
export const asQoderContent = (content: Claude.SDKUserMessage['message']['content']) =>
  content as unknown as Qoder.SDKUserMessage['message']['content']
