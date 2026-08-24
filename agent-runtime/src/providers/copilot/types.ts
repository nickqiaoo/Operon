/**
 * Event shapes emitted by the Copilot CLI runtime, surfaced through
 * `@github/copilot-sdk`'s typed event stream (`session.on`).
 *
 * The SDK ships the full discriminated union (`SessionEvent`) plus every
 * individual variant. We re-export only the variants the message-mapper
 * consumes, so the mapper and its tests import event types from one place.
 *
 * Source: node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts
 */
export type {
  SessionEvent as CopilotSessionEvent,
  AssistantMessageDeltaEvent,
  AssistantMessageEvent,
  AssistantReasoningDeltaEvent,
  AssistantReasoningEvent,
  ToolExecutionStartEvent,
  ToolExecutionCompleteEvent,
  UsageInfoEvent,
  IdleEvent,
  ErrorEvent as CopilotErrorEvent,
} from '@github/copilot-sdk'
