import { defineMessages, type IntlShape, type MessageDescriptor } from "react-intl"
import type { AgentSessionStatus, BindingStatus, BindingScopeKind } from "@/types/channel"

/**
 * Agent / binding session status labels as react-intl descriptors. These enum
 * values are shown both as visible text and as `title` tooltips, so they live
 * as descriptors and are resolved at the call site. `defineMessages` keeps them
 * statically extractable by @formatjs/cli (English is the source of truth).
 */
export const AGENT_STATUS_MESSAGES = defineMessages({
  active: { id: "channel.agentStatus.active", defaultMessage: "Active" },
  idle: { id: "channel.agentStatus.idle", defaultMessage: "Idle" },
  offline: { id: "channel.agentStatus.offline", defaultMessage: "Offline" },
  completed: { id: "channel.agentStatus.completed", defaultMessage: "Completed" },
}) satisfies Record<AgentSessionStatus | BindingStatus, MessageDescriptor>

export function agentStatusLabel(intl: IntlShape, status: AgentSessionStatus | BindingStatus): string {
  return intl.formatMessage(AGENT_STATUS_MESSAGES[status])
}

/**
 * Binding scope-kind labels. `app` reads as "channel" in the UI; the IM brand
 * names stay verbatim across locales.
 */
export const SCOPE_MESSAGES = defineMessages({
  app: { id: "channel.scope.app", defaultMessage: "channel" },
  slack: { id: "channel.scope.slack", defaultMessage: "slack" },
  telegram: { id: "channel.scope.telegram", defaultMessage: "telegram" },
  linear: { id: "channel.scope.linear", defaultMessage: "linear" },
  task: { id: "channel.scope.task", defaultMessage: "task" },
}) satisfies Record<BindingScopeKind, MessageDescriptor>

export function scopeLabel(intl: IntlShape, kind: BindingScopeKind): string {
  // Defensive: a binding may carry a scope kind not yet in SCOPE_MESSAGES (e.g.
  // a server-side kind the frontend hasn't caught up to). formatMessage(undefined)
  // throws "an `id` must be provided", so fall back to the raw kind string.
  const descriptor = SCOPE_MESSAGES[kind as keyof typeof SCOPE_MESSAGES]
  return descriptor ? intl.formatMessage(descriptor) : String(kind)
}
