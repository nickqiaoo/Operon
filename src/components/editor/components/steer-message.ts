import type { FileUIPart, UIMessage } from 'ai';

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

type InjectedPartData = Partial<InjectedInputData> & { notice?: unknown };

function injectedData(part: MessagePart): InjectedPartData | undefined {
  if (part.type !== INJECTED_INPUT_PART || !('data' in part)) return undefined;
  return part.data as InjectedPartData | undefined;
}

/** A follow-up the user sent, where the agent read it. Never an automated notice. */
export function getInjectedInput(part: MessagePart): InjectedInputData | null {
  const data = injectedData(part);
  if (data?.notice === true) return null;
  return typeof data?.id === 'string' && typeof data.text === 'string' ? { id: data.id, text: data.text } : null;
}

/**
 * An automated event the agent read mid-turn (a background task settling while it
 * worked), at the point it read it. Marked the same way as a steer, but nobody sent
 * it, so it is not a steer: it never answers a question or leaves the steer tray.
 */
export function getInjectedNotice(part: MessagePart): string | null {
  const data = injectedData(part);
  return data?.notice === true && typeof data.text === 'string' && data.text ? data.text : null;
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

/**
 * Files sent with each follow-up, by steer message id: the persisted steer rows
 * (hidden once the reply shows them in place), then `live` — what this surface sent
 * this turn, before those rows reach it.
 */
export function collectSteerAttachments(
  messages: readonly UIMessage[],
  live?: ReadonlyMap<string, readonly FileUIPart[]>,
): Map<string, readonly FileUIPart[]> {
  const byId = new Map<string, readonly FileUIPart[]>(live ?? []);
  for (const message of messages) {
    if (!getSteerMessageMetadata(message)) continue;
    const files = message.parts.filter((part): part is FileUIPart => part.type === 'file');
    if (files.length > 0) byId.set(message.id, files);
  }
  return byId;
}

export type LiveSteerStatus = 'sending' | 'sent' | 'failed' | 'unknown';

export type LiveSteerItem = {
  localId: string;
  messageId?: string;
  turnMessageId?: string;
  text: string;
  /** Attachments sent with it, already at durable URLs so a retry sends the same ones. */
  files?: FileUIPart[];
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
