// Relays inbox notifications to the user's phones as APNs / FCM pushes.
//
// This machine is the only one that knows a turn finished or a task moved, but
// it holds no APNs or FCM credentials — those are per-developer-account secrets
// and cannot be handed to every machine running operon — and it does not know
// which phones the account owns. The broker has both, so the node posts the
// message there with its node token and the broker fans it out. See
// broker/apns.go.
//
// Entirely best-effort. A machine that never connected to the SaaS has no
// broker URL or node token and simply skips.

import type { NotificationSeverity } from '../types/notification.js'
import { getSaasConfig } from '../gateway/saas/config.js'
import { BROKER_URL } from '../gateway/saas/broker.js'
import { brokerHttpBase } from '../../../tunnel-agent/src/saasConfig.js'

export interface PushMessage {
  /** Gate: only 'action' — something is actually blocked on you — reaches a phone. */
  severity: NotificationSeverity
  /** The inbox row's coalescing key ('chat:42'); the broker reuses it as the
   *  APNs collapse-id so repeats replace the banner instead of stacking. */
  sourceKey: string
  title: string
  body?: string
  chatId?: number
  taskId?: number
  /** Needed on the phone to switch context before opening the target. */
  projectId?: number
  workspaceId?: number
  kind?: string
}

/** Timeout so a slow broker can never hold up a chat turn's completion path. */
const PUSH_TIMEOUT_MS = 5_000

/**
 * Floor on how often one source may buzz a phone. The inbox has no such limit —
 * it is a list you choose to look at — but a notification is an interruption,
 * and a source that fires in a tight loop would otherwise ring once per event.
 * Backstop only: the callers are expected not to produce bursts in the first
 * place (see observeApprovalPart).
 */
const PUSH_MIN_INTERVAL_MS = 60_000

const lastPushBySource = new Map<string, number>()

/**
 * Deliver to the user's phones, if this is worth interrupting them for.
 *
 * The policy deliberately starts narrow: **only `severity: 'action'`** — the
 * agent is waiting on you, or a task wants your review. Everything else
 * ('finished responding', 'task done') is real information but has no action
 * attached, and it is also the high-frequency half: a normal hour at the desk
 * produces one chat_complete per turn. Pushing those trains users to switch
 * notifications off, at which point the ones that matter are lost too.
 *
 * Widening this later (e.g. "push chat_complete once you have been away from
 * the desktop for ten minutes") is additive. Starting wide and walking it back
 * is not — the permission is already revoked.
 */
export function relayPush(message: PushMessage): void {
  if (message.severity !== 'action') return
  if (!message.title) return

  const cfg = getSaasConfig()
  if (!cfg.nodeToken) return

  const now = Date.now()
  const last = lastPushBySource.get(message.sourceKey)
  if (last !== undefined && now - last < PUSH_MIN_INTERVAL_MS) return
  pruneThrottleMap(now)
  lastPushBySource.set(message.sourceKey, now)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)

  void fetch(`${brokerHttpBase(BROKER_URL)}/agent/push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.nodeToken}`,
    },
    body: JSON.stringify(message),
    signal: controller.signal,
  })
    .catch(() => {
      // Offline, broker down, or push not configured on the broker. The inbox
      // row is already written either way, so the user still sees it in-app.
    })
    .finally(() => clearTimeout(timer))
}

/** Drop entries that can no longer suppress anything, so a long-lived process
 *  does not accumulate one row per chat it ever notified about. */
function pruneThrottleMap(now: number): void {
  if (lastPushBySource.size < 64) return
  for (const [key, at] of lastPushBySource) {
    if (now - at >= PUSH_MIN_INTERVAL_MS) lastPushBySource.delete(key)
  }
}
