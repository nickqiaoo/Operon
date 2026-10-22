import type { UIMessage } from 'ai';

export type SteerMessageMetadata = {
  steer: true;
  turnMessageId?: string;
};

/**
 * Where a follow-up the user sent mid-turn reached the agent: a data part inside
 * the assistant's reply, written by the server at that point in the stream (see
 * `writeInjectedInput` in agent-runtime). `id` is the steer message's id.
 */
export const INJECTED_INPUT_PART = 'data-injected-input';

export type InjectedInputData = { id: string; text: string };

type MessagePart = UIMessage['parts'][number];

export function getInjectedInput(part: MessagePart): InjectedInputData | null {
  if (part.type !== INJECTED_INPUT_PART || !('data' in part)) return null;
  const data = part.data as Partial<InjectedInputData> | undefined;
  return typeof data?.id === 'string' && typeof data.text === 'string' ? { id: data.id, text: data.text } : null;
}

/** Steer ids already shown inside a reply, where the agent read them. */
export function collectInjectedInputIds(messages: readonly UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      const injected = getInjectedInput(part);
      if (injected) ids.add(injected.id);
    }
  }
  return ids;
}

export type LiveSteerStatus = 'sending' | 'sent' | 'failed' | 'unknown';

export type LiveSteerItem = {
  localId: string;
  messageId?: string;
  turnMessageId?: string;
  text: string;
  status: LiveSteerStatus;
};

export function getSteerMessageMetadata(message: UIMessage): SteerMessageMetadata | null {
  if (message.role !== 'user' || !message.metadata || typeof message.metadata !== 'object') {
    return null;
  }

  const metadata = message.metadata as Record<string, unknown>;
  if (metadata.steer !== true) return null;

  return {
    steer: true,
    turnMessageId:
      typeof metadata.turnMessageId === 'string' && metadata.turnMessageId.length > 0
        ? metadata.turnMessageId
        : undefined,
  };
}

export function isSteerUserMessage(message: UIMessage): boolean {
  return getSteerMessageMetadata(message) !== null;
}

export function findLatestTurnMessageId(messages: readonly UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && !isSteerUserMessage(message)) return message.id;
  }
  return undefined;
}

export type ArchivedSteerPresentation = {
  messages: UIMessage[];
  steersByUserMessageId: ReadonlyMap<string, UIMessage[]>;
};

/**
 * Keeps steer messages durable in history while presenting them as follow-ups
 * beneath the user message that owns the turn. Legacy steer rows without an
 * explicit turn id fall back to the latest ordinary user message before them.
 *
 * A steer the reply already shows (its `data-injected-input` part, where the
 * agent read it) is dropped here instead: the reply is the accurate place, and
 * this one would only repeat it. Rows from providers that cannot tell when they
 * read a message still land under the user message as before.
 */
export function groupArchivedSteers(messages: readonly UIMessage[]): ArchivedSteerPresentation {
  const shownInReply = collectInjectedInputIds(messages);
  if (shownInReply.size > 0) {
    messages = messages.filter((message) => !(shownInReply.has(message.id) && getSteerMessageMetadata(message)));
  }
  const targetTurnBySteerId = new Map<string, string>();
  const userMessageIds = new Set<string>();
  let currentTurnMessageId: string | undefined;

  for (const message of messages) {
    const steerMetadata = getSteerMessageMetadata(message);
    if (steerMetadata) {
      const targetTurnMessageId = steerMetadata.turnMessageId ?? currentTurnMessageId;
      if (targetTurnMessageId) targetTurnBySteerId.set(message.id, targetTurnMessageId);
      continue;
    }

    if (message.role === 'user') {
      currentTurnMessageId = message.id;
      userMessageIds.add(message.id);
    }
  }

  const attachedSteerIds = new Set<string>();
  const steersByUserMessageId = new Map<string, UIMessage[]>();

  for (const message of messages) {
    const targetTurnMessageId = targetTurnBySteerId.get(message.id);
    if (!targetTurnMessageId || !userMessageIds.has(targetTurnMessageId)) continue;

    const existing = steersByUserMessageId.get(targetTurnMessageId);
    if (existing) {
      existing.push(message);
    } else {
      steersByUserMessageId.set(targetTurnMessageId, [message]);
    }
    attachedSteerIds.add(message.id);
  }

  return {
    messages: messages.filter((message) => !attachedSteerIds.has(message.id)),
    steersByUserMessageId,
  };
}
