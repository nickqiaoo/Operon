import type { UIMessage } from 'ai';
import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { CornerDownRight } from 'lucide-react';
import type { EditorTab } from '@/types/editor';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from '@/components/ai-elements/checkpoint';
import { TurnDiffCard, type TurnDiffFile } from './TurnDiffCard';
import { AssistantMessageActions, MessagePartRenderer } from './MessagePartRenderer';
import { UserMessageText } from './UserMessageText';
import { SendToButton } from '../SendToButton';
import { SendToChatButton } from '../SendToChatButton';
import {
  extractExternalAgentTaskId,
  isExternalAgentTool,
  type ExternalAgentResultMetadata,
} from './ExternalAgentRenderer';
import { getParentToolCallId, getToolCallId, isToolPart } from './toolParentUtils';
import type { SendToModel } from '../SendToButton';
import { segmentMessageParts } from './compact-tool/segmentParts';
import { ToolCallGroup } from './compact-tool/ToolCallGroup';
import { groupArchivedSteers } from './steer-message';

type MessagePart = UIMessage['parts'][number];
type AttachmentPart = Extract<MessagePart, { type: 'file' | 'source-document' }>;
type TextPart = Extract<MessagePart, { type: 'text' }>;

const isAttachmentPart = (part: MessagePart): part is AttachmentPart =>
  part.type === 'file' || part.type === 'source-document';

const isTextPart = (part: MessagePart): part is TextPart => part.type === 'text';

const getMessageText = (message: UIMessage) =>
  (message.parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join('');

const getFilteredMessageText = (message: UIMessage) =>
  (message.parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join('')
    .trim();

const hasAssistantActionCandidate = (message: UIMessage) =>
  message.role === 'assistant' &&
  (message.parts ?? []).some((part) => isTextPart(part) && part.text.trim().length > 0);

const hasExternalAgentToolPart = (message: UIMessage) =>
  (message.parts ?? []).some((part) => {
    if (part.type !== 'dynamic-tool' && !(part.type as string).startsWith('tool-')) {
      return false;
    }
    return isExternalAgentTool(part as { toolName?: string; name?: string });
  });

/**
 * Browser-level windowing for messages scrolled far out of view.
 *
 * A long transcript is expensive because of DOM *size*, not React work: work
 * groups already collapse (Radix unmounts closed content) and every message is
 * memoized, so streaming only re-renders the tail. What still costs is layout
 * and paint over thousands of nodes of markdown and diff cards.
 *
 * `content-visibility: auto` lets the engine skip that work entirely for
 * subtrees outside the viewport, with none of the tradeoffs of a virtualized
 * list — find-in-page, anchor links, Cmd+F and the stick-to-bottom scroller all
 * keep working because the elements stay in the DOM. `contain-intrinsic-size:
 * auto <fallback>` makes the browser remember each message's real measured
 * height once rendered, so the scrollbar stops drifting after the first pass;
 * the fallback only applies to messages never yet displayed.
 */
const OFFSCREEN_DEFER_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 240px',
};

/**
 * Messages this close to the end are never deferred. The streaming tail resizes
 * every token and the reader is usually parked there, so skipping layout for it
 * would buy nothing and risks scroll jitter exactly where it is most visible.
 */
const LIVE_TAIL_SIZE = 8;

interface MessagesListProps {
  messages: UIMessage[];
  status: string;
  onPermissionDecide: (id: string, outcome: 'allow' | 'deny' | 'allowAlways', updatedInput?: Record<string, unknown>) => Promise<boolean>;
  onSendTo: (modelId: string, providerId: string, text: string) => void;
  onSendToTab: (chatId: string, text: string) => void;
  tabs: EditorTab[];
  currentChatId: string;
  availableModels: SendToModel[];
  onSendToOpen?: () => void;
  onRewindToCheckpoint?: (userMessageId: string) => void;
  rewindedCheckpoint?: { messageId: string; backupSnapshotId: string } | null;
  onUndoRewind?: () => void;
  /**
   * Set of user-message ids that have a rewind checkpoint. When provided, the
   * Rewind affordance is shown only for messages in the set (turns that changed
   * no files have no checkpoint). When undefined (not yet loaded), the
   * affordance falls back to showing.
   */
  /** Per-turn file diffs (keyed by the round's user message); one card per turn. */
  turnDiffs?: { turns: Array<{ messageUid: string; snapshotId: string; files: TurnDiffFile[] }> } | null;
  /** Open the Review tab focused on the given turn (the round's user-message id). */
  onReviewTurn?: (messageUid: string) => void;
  externalAgentNotificationsByTaskId?: ReadonlyMap<string, ExternalAgentResultMetadata>;
}

interface MessageItemProps {
  message: UIMessage;
  archivedSteers?: readonly UIMessage[];
  isStreamingMessage: boolean;
  isLastAssistantInRound: boolean;
  /** Let the browser skip layout/paint while this message is out of view. */
  deferOffscreen: boolean;
  precedingUserMessageId?: string;
  isRewindedCheckpoint: boolean;
  /** This turn's changed files; rendered as a card at the end of the round. */
  turnDiffFiles?: TurnDiffFile[];
  onReviewTurn?: (messageUid: string) => void;
  externalAgentNotificationsByTaskId?: ReadonlyMap<string, ExternalAgentResultMetadata>;
  onPermissionDecide: (id: string, outcome: 'allow' | 'deny' | 'allowAlways', updatedInput?: Record<string, unknown>) => Promise<boolean>;
  onCopy: (text: string) => void;
  onSendTo: (modelId: string, providerId: string, text: string) => void;
  onSendToTab: (chatId: string, text: string) => void;
  tabs: EditorTab[];
  currentChatId: string;
  availableModels: SendToModel[];
  onSendToOpen?: () => void;
  onRewindToCheckpoint?: (userMessageId: string) => void;
  onUndoRewind?: () => void;
}

function ArchivedSteers({ messages }: { messages: readonly UIMessage[] }) {
  if (messages.length === 0) return null;
  const texts = messages.map((message) => getMessageText(message));

  return (
    <div
      data-testid="archived-steers"
      className="mt-0.5 ml-auto flex w-fit min-w-0 max-w-[90%] items-center gap-1.5 rounded-md bg-tint/5 px-2 py-1 text-xs text-foreground/80"
    >
      <CornerDownRight aria-hidden="true" className="size-3 shrink-0 text-tint/80" />
      <span className="shrink-0 font-medium text-muted-foreground">
        <FormattedMessage
          id="editor.steer.archived"
          defaultMessage="{count, plural, one {Follow-up} other {{count} follow-ups}}"
          values={{ count: messages.length }}
        />
      </span>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">·</span>
      <span
        data-testid="archived-steer"
        title={texts.join('\n')}
        className="min-w-0 truncate text-foreground/80"
      >
        {texts.join(' · ')}
      </span>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  archivedSteers = [],
  isStreamingMessage,
  isLastAssistantInRound,
  deferOffscreen,
  precedingUserMessageId,
  isRewindedCheckpoint,
  turnDiffFiles,
  onReviewTurn,
  externalAgentNotificationsByTaskId,
  onPermissionDecide,
  onCopy,
  onSendTo,
  onSendToTab,
  tabs,
  currentChatId,
  availableModels,
  onSendToOpen,
  onRewindToCheckpoint,
  onUndoRewind,
}: MessageItemProps) {
  const intl = useIntl();
  const sortedParts: MessagePart[] = message.parts ?? [];
  const attachmentParts = sortedParts.filter(isAttachmentPart);
  const firstAttachmentIndex = sortedParts.findIndex(isAttachmentPart);
  const textPartIndices = sortedParts.reduce<number[]>((indices, part, partIndex) => {
    if (isTextPart(part) && part.text.trim().length > 0) {
      indices.push(partIndex);
    }
    return indices;
  }, []);
  const lastTextPartIndex = textPartIndices[textPartIndices.length - 1];

  const childPartsMap = new Map<string, number[]>();
  const childIndices = new Set<number>();

  for (let index = 0; index < sortedParts.length; index += 1) {
    const part = sortedParts[index];
    if (!isToolPart(part)) continue;

    const parentId = getParentToolCallId(part);
    if (!parentId) continue;

    const existing = childPartsMap.get(parentId);
    if (existing) {
      existing.push(index);
    } else {
      childPartsMap.set(parentId, [index]);
    }
    childIndices.add(index);
  }

  const activeStreamingPartIndex = isStreamingMessage
    ? sortedParts.reduce((lastIndex, part, partIndex) => {
        if (childIndices.has(partIndex) || part.type === 'step-start') {
          return lastIndex;
        }
        return partIndex;
      }, -1)
    : -1;

  // Per-turn footer (diff card / rewound indicator). Rendered by the part
  // renderer at the last text part — above the message's action row.
  const turnFooter =
    isLastAssistantInRound && precedingUserMessageId && onRewindToCheckpoint ? (
      isRewindedCheckpoint ? (
        <Checkpoint className="mt-1">
          <CheckpointIcon />
          <span className="text-xs text-muted-foreground"><FormattedMessage id="editor.rewind.rewound" defaultMessage="Rewound" /></span>
          <CheckpointTrigger tooltip={intl.formatMessage({ id: 'editor.rewind.undoTooltip', defaultMessage: 'Undo rewind' })} onClick={onUndoRewind}>
            <FormattedMessage id="editor.rewind.undo" defaultMessage="Undo" />
          </CheckpointTrigger>
        </Checkpoint>
      ) : turnDiffFiles != null && turnDiffFiles.length > 0 ? (
        <TurnDiffCard
          files={turnDiffFiles}
          onUndo={() => onRewindToCheckpoint(precedingUserMessageId)}
          onReview={onReviewTurn ? () => onReviewTurn(precedingUserMessageId) : undefined}
          // mb-3 separates the turn's diff card from the next turn's user message
          // (the list container only puts gap-1 between messages, which is too
          // tight against this heavier bordered card).
          className="mt-2 mb-3"
        />
      ) : null
    ) : null;

  return (
    <div
      data-message-item-role={message.role}
      className="space-y-1"
      style={deferOffscreen ? OFFSCREEN_DEFER_STYLE : undefined}
    >
      {sortedParts.length > 0 ? (
        (() => {
          const segments = segmentMessageParts(sortedParts, childIndices, activeStreamingPartIndex);
          return segments.map((segment, segIdx) => {
            if (segment.type === 'tool-group') {
              return (
                <div key={`${message.id}-group-${segIdx}`}>
                  <ToolCallGroup
                    parts={segment.partIndices.map((i) => sortedParts[i])}
                    partIndices={segment.partIndices}
                    messageId={message.id}
                    onPermissionDecide={onPermissionDecide}
                  />
                </div>
              );
            }

            const partIndex = segment.partIndex;
            const part = sortedParts[partIndex];
            const toolCallId = isToolPart(part) ? getToolCallId(part) : null;
            const childPartIndices = toolCallId ? childPartsMap.get(toolCallId) : undefined;
            const childToolParts = childPartIndices
              ? childPartIndices.map((index) => sortedParts[index])
              : undefined;

            return (
              <div key={`${message.id}-${partIndex}`}>
                <MessagePartRenderer
                  message={message}
                  part={part}
                  partIndex={partIndex}
                  isStreamingMessage={isStreamingMessage}
                  onPermissionDecide={onPermissionDecide}
                  onCopy={onCopy}
                  onSendTo={onSendTo}
                  availableModels={availableModels}
                  onSendToOpen={onSendToOpen}
                  getMessageText={getMessageText}
                  firstAttachmentIndex={firstAttachmentIndex}
                  attachmentParts={attachmentParts}
                  lastTextPartIndex={lastTextPartIndex}
                  SendToButton={SendToButton}
                  childParts={childToolParts}
                  externalAgentNotificationsByTaskId={externalAgentNotificationsByTaskId}
                />
              </div>
            );
          });
        })()
      ) : (
        <Message from={message.role}>
          <MessageContent>
            {message.role === 'user' ? (
              <UserMessageText text={getMessageText(message)} />
            ) : (
              <MessageResponse mode={isStreamingMessage ? 'streaming' : 'static'}>
                {getMessageText(message)}
              </MessageResponse>
            )}
          </MessageContent>
        </Message>
      )}
      {/* The assistant action row and the turn footer (diff card / rewound
          indicator) live here — after every part — so they always sit at the
          bottom of the turn, even when it ends on a tool call rather than a text
          block. The action row renders under EVERY assistant message (except the
          one actively streaming); the turn footer is turn-level, so it stays
          gated on isLastAssistantInRound. Order: action row hugs the response
          text, then the turn footer sits below it. */}
      {message.role === 'assistant' && !isStreamingMessage && (
        <AssistantMessageActions
          text={getFilteredMessageText(message)}
          onCopy={onCopy}
          onSendToTab={onSendToTab}
          tabs={tabs}
          currentChatId={currentChatId}
          SendToChatButton={SendToChatButton}
        />
      )}
      <ArchivedSteers messages={archivedSteers} />
      {turnFooter}
    </div>
  );
});

export const MessagesList = memo(function MessagesList({
  messages: messagesProp,
  status,
  onPermissionDecide,
  onSendTo,
  onSendToTab,
  tabs,
  currentChatId,
  availableModels,
  onSendToOpen,
  onRewindToCheckpoint,
  rewindedCheckpoint,
  onUndoRewind,
  turnDiffs,
  onReviewTurn,
  externalAgentNotificationsByTaskId,
}: MessagesListProps) {
  // Guard against duplicate message ids in the source array (a history + live
  // merge can produce them). Dedupe by id — keeping each id's first position
  // with its latest content — so React doesn't warn or drop/duplicate rows.
  // Also log when it catches dups, to pinpoint the upstream source.
  const dedupedMessages = useMemo(() => {
    const map = new Map<string, UIMessage>();
    const dups: string[] = [];
    for (const m of messagesProp) {
      if (map.has(m.id)) dups.push(m.id);
      map.set(m.id, m);
    }
    if (dups.length > 0) {
      console.warn(
        '[MessagesList] duplicate message ids (deduped at render):',
        dups.map((id) => ({ id, role: messagesProp.find((m) => m.id === id)?.role })),
        `total=${messagesProp.length}`,
      );
    }
    return Array.from(map.values());
  }, [messagesProp]);

  const archivedPresentation = useMemo(
    () => groupArchivedSteers(dedupedMessages),
    [dedupedMessages],
  );
  const messages = archivedPresentation.messages;

  const externalAgentNotificationsByMessageId = useMemo(() => {
    const notifications = new Map<string, ReadonlyMap<string, ExternalAgentResultMetadata>>();

    if (!externalAgentNotificationsByTaskId || externalAgentNotificationsByTaskId.size === 0) {
      return notifications;
    }

    for (const message of messages) {
      if (!hasExternalAgentToolPart(message)) continue;

      const messageNotifications = new Map<string, ExternalAgentResultMetadata>();
      for (const part of message.parts ?? []) {
        if (part.type !== 'dynamic-tool' && !(part.type as string).startsWith('tool-')) continue;
        const taskId = extractExternalAgentTaskId(part as { result?: unknown; output?: unknown });
        if (!taskId) continue;

        const notificationInfo = externalAgentNotificationsByTaskId.get(taskId);
        if (notificationInfo) {
          messageNotifications.set(taskId, notificationInfo);
        }
      }

      if (messageNotifications.size > 0) {
        notifications.set(message.id, messageNotifications);
      }
    }

    return notifications;
  }, [externalAgentNotificationsByTaskId, messages]);

  const precedingUserMessageIds = useMemo(() => {
    const ids: Array<string | undefined> = new Array(messages.length);
    let lastUserMessageId: string | undefined;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      ids[index] = message.role === 'assistant' ? lastUserMessageId : undefined;
      if (message.role === 'user') {
        lastUserMessageId = message.id;
      }
    }

    return ids;
  }, [messages]);

  const lastAssistantInRoundIds = useMemo(() => {
    const ids = new Set<string>();
    let latestAssistantInRoundFound = false;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user') {
        latestAssistantInRoundFound = false;
        continue;
      }

      if (!hasAssistantActionCandidate(message)) continue;
      if (latestAssistantInRoundFound) continue;

      ids.add(message.id);
      latestAssistantInRoundFound = true;
    }

    return ids;
  }, [messages]);

  // Map each round's user message id → that turn's changed files.
  const turnFilesByMessageId = useMemo(() => {
    const map = new Map<string, TurnDiffFile[]>();
    for (const turn of turnDiffs?.turns ?? []) {
      if (turn.files.length > 0) map.set(turn.messageUid, turn.files);
    }
    return map;
  }, [turnDiffs]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  const lastMessageIndex = messages.length - 1;

  return (
    <>
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          archivedSteers={archivedPresentation.steersByUserMessageId.get(message.id)}
          isStreamingMessage={status === 'streaming' && index === lastMessageIndex}
          isLastAssistantInRound={lastAssistantInRoundIds.has(message.id)}
          deferOffscreen={index < lastMessageIndex - LIVE_TAIL_SIZE}
          precedingUserMessageId={precedingUserMessageIds[index]}
          isRewindedCheckpoint={rewindedCheckpoint?.messageId === precedingUserMessageIds[index]}
          turnDiffFiles={
            precedingUserMessageIds[index] != null
              ? turnFilesByMessageId.get(precedingUserMessageIds[index]!)
              : undefined
          }
          onReviewTurn={onReviewTurn}
          externalAgentNotificationsByTaskId={externalAgentNotificationsByMessageId.get(message.id)}
          onPermissionDecide={onPermissionDecide}
          onCopy={handleCopy}
          onSendTo={onSendTo}
          onSendToTab={onSendToTab}
          tabs={tabs}
          currentChatId={currentChatId}
          availableModels={availableModels}
          onSendToOpen={onSendToOpen}
          onRewindToCheckpoint={onRewindToCheckpoint}
          onUndoRewind={onUndoRewind}
        />
      ))}
    </>
  );
});
