import type { UIMessage } from 'ai';

export type SteerMessageMetadata = {
  steer: true;
  turnMessageId?: string;
};

export type LiveSteerStatus = 'sending' | 'sent' | 'failed';

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
 */
export function groupArchivedSteers(messages: readonly UIMessage[]): ArchivedSteerPresentation {
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
