import type { UIMessage } from 'ai';
import { useState, useCallback, type ReactElement } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { CheckCircle2Icon, CheckIcon, CopyIcon } from 'lucide-react';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from '@/components/ai-elements/message';
import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments';
import { cn } from '@/lib/utils';
import type { EditorTab } from '@/types/editor';
import { PlanRenderer } from './PlanRenderer';
import { ShareButton } from './ShareButton';
import { SubAgentRenderer } from './SubAgentRenderer';
import { ToolInvocationRenderer } from './ToolInvocationRenderer';
import { AskUserQuestionRenderer, isAskUserQuestionTool } from './AskUserQuestionRenderer';
import { TodoWriteRenderer, isTodoWriteTool } from './TodoWriteRenderer';
import { WorkflowToolRenderer, isWorkflowTool } from './WorkflowToolRenderer';
import { WorkflowResultMessage, isWorkflowResultMessage } from './WorkflowResultMessage';
import {
  ExternalAgentToolRenderer,
  ExternalAgentResultRenderer,
  extractExternalAgentTaskId,
  type ExternalAgentResultMetadata,
  isExternalAgentTool,
  isExternalAgentResultMessage,
} from './ExternalAgentRenderer';
import { isCodexCollabAgentTool } from './CodexCollabAgentRenderer';
import { isOpencodeSubtaskTool } from './OpencodeSubtaskRenderer';
import { getSubagentProgress, convertSubagentToChildParts, mapSubagentState } from './gemini-subagent-utils';
import { getToolDisplayName, type ToolPartLike } from './toolName';
import { TaskCreatedRenderer, createdTaskNumber } from './TaskCreatedRenderer';
import { UserMessageText } from './UserMessageText';
import { PeerMessage } from './PeerMessage';
import { extractPeerMessage } from '../utils/chatMetadata';
import { UserContextBlocks } from './UserContextBlocks';
import { parseContextBlocks } from '@/lib/context-blocks';
import type { SendToModel } from '../SendToButton';

const skillTagPattern = /\[skill:([\w-]+)\]/g;

function parseSkillTags(text: string): { skills: string[]; cleanText: string } {
  const skills: string[] = [];
  const cleanText = text.replace(skillTagPattern, (_, name: string) => {
    skills.push(name);
    return '';
  }).trim();
  return { skills, cleanText };
}

function isSteerUserMessage(message: UIMessage): boolean {
  if (message.role !== 'user' || !message.metadata || typeof message.metadata !== 'object') {
    return false;
  }

  const metadata = message.metadata as Record<string, unknown>;
  return metadata.steer === true;
}

function SkillTag({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-tint-muted px-1.5 py-px text-sm text-tint">
      {name}
    </span>
  );
}

function CopyButton({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
    onCopy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text, onCopy]);

  return (
    <MessageAction onClick={handleClick} label={intl.formatMessage({ id: 'common.copy', defaultMessage: 'Copy' })}>
      {copied ? <CheckIcon className="size-3 text-green-500" /> : <CopyIcon className="size-3" />}
    </MessageAction>
  );
}

/**
 * Assistant message action row (send-to / copy / share). Rendered at the message
 * level — after every part — so it always sits at the very bottom of the turn,
 * even when the turn ends on a tool call rather than a trailing text block.
 */
export function AssistantMessageActions({
  text,
  onCopy,
  onSendToTab,
  tabs,
  currentChatId,
  SendToChatButton,
}: {
  text: string;
  onCopy: (text: string) => void;
  onSendToTab: (chatId: string, text: string) => void;
  tabs: EditorTab[];
  currentChatId: string;
  SendToChatButton: (props: { tabs: EditorTab[]; onSendTo: (tabId: string) => void; currentChatId: string }) => ReactElement | null;
}) {
  if (!text) return null;
  return (
    <MessageActions className="-ml-2.5">
      <SendToChatButton
        tabs={tabs}
        currentChatId={currentChatId}
        onSendTo={(targetId: string) => onSendToTab(targetId, text)}
      />
      <CopyButton text={text} onCopy={onCopy} />
      <ShareButton text={text} />
    </MessageActions>
  );
}

type MessagePart = UIMessage['parts'][number];

interface MessagePartRendererProps {
  message: UIMessage;
  part: MessagePart;
  partIndex: number;
  isStreamingMessage: boolean;
  onPermissionDecide: (id: string, outcome: 'allow' | 'deny' | 'allowAlways', updatedInput?: Record<string, unknown>) => Promise<boolean>;
  onCopy: (text: string) => void;
  onSendTo: (modelId: string, providerId: string, text: string) => void;
  availableModels: SendToModel[];
  onSendToOpen?: () => void;
  getMessageText: (m: UIMessage) => string;
  firstAttachmentIndex: number;
  attachmentParts: MessagePart[];
  lastTextPartIndex: number;
  SendToButton: (props: { availableModels: SendToModel[]; onSendTo: (modelId: string, providerId: string) => void; onOpen?: () => void }) => ReactElement;
  childParts?: MessagePart[];
  externalAgentNotificationsByTaskId?: ReadonlyMap<string, ExternalAgentResultMetadata>;
}

export function MessagePartRenderer({
  message,
  part,
  partIndex,
  isStreamingMessage,
  onPermissionDecide,
  onCopy,
  onSendTo,
  availableModels,
  onSendToOpen,
  getMessageText,
  firstAttachmentIndex,
  attachmentParts,
  lastTextPartIndex,
  SendToButton,
  childParts,
  externalAgentNotificationsByTaskId,
}: MessagePartRendererProps) {
  // Handle tool invocations
  if (part.type === 'dynamic-tool' || (part.type as string).startsWith('tool-')) {
    const toolPart = part as ToolPartLike;
    const rawInput = (toolPart.args || toolPart.input || {}) as {
      title?: string;
      toolName?: string;
      rawInput?: { plan?: string };
      args?: { plan?: string };
      plan?: string;
    };
    const toolName = getToolDisplayName(toolPart);

    const isExitPlanToolName = (name?: string) =>
      name === 'ExitPlanMode' ||
      name === 'tool-ExitPlanMode' ||
      name === 'Ready to code?' ||
      name === 'tool-Ready to code?' ||
      name === 'exit_plan_mode';

    // Detect ExitPlanMode (plan review) tool call
    const isExitPlan =
      isExitPlanToolName(toolName) ||
      isExitPlanToolName(rawInput?.title) ||
      isExitPlanToolName(rawInput?.toolName);
    // CC embeds plan markdown directly; Gemini provides plan_path
    const planMarkdown =
      rawInput?.rawInput?.plan || rawInput?.args?.plan || rawInput?.plan;
    const planPath = (rawInput as Record<string, unknown>)?.plan_path as string | undefined;

    if (isExitPlan) {
      return (
        <PlanRenderer
          toolPart={toolPart}
          planMarkdown={planMarkdown}
          planPath={planPath}
          messageId={message.id}
          partIndex={partIndex}
          onPermissionDecide={onPermissionDecide}
          isGemini={!!planPath && !planMarkdown}
        />
      );
    }

    // A taskboard tool that created a task renders as a card linking to its detail
    // page. Gated on the task actually existing, not merely on the tool name: a
    // streaming or failed create has nothing to link to, and must fall through to
    // the default tool rendering rather than render as nothing. (The streaming
    // case reaches here despite isCompactEligible, because segmentMessageParts
    // always keeps the active part as its own segment.)
    if (createdTaskNumber(toolPart) !== null) {
      return <TaskCreatedRenderer toolPart={toolPart} />;
    }

    // Render Workflow tool with dedicated card (phases skeleton + highlighted script +
    // live sub-agent progress). WorkflowToolRenderer reads isSubagentProgress itself.
    if (isWorkflowTool(toolPart)) {
      return (
        <WorkflowToolRenderer
          toolPart={toolPart}
          messageId={message.id}
          partIndex={partIndex}
          childParts={childParts?.map((cp) => {
            if (cp.type === 'tool-invocation' && 'toolInvocation' in cp) {
              return (cp as unknown as { toolInvocation: ToolPartLike }).toolInvocation;
            }
            return cp as unknown as ToolPartLike;
          })}
          onPermissionDecide={onPermissionDecide}
        />
      );
    }

    // Render AskUserQuestion tool with special UI for questions
    if (isAskUserQuestionTool(toolPart)) {
      return (
        <AskUserQuestionRenderer
          toolPart={toolPart}
          messageId={message.id}
          partIndex={partIndex}
          onPermissionDecide={onPermissionDecide}
        />
      );
    }

    // Render TodoWrite tool with dedicated Queue-based UI
    if (isTodoWriteTool(toolPart)) {
      return (
        <TodoWriteRenderer
          toolPart={toolPart}
          messageId={message.id}
          partIndex={partIndex}
        />
      );
    }

    // Render external agent run tool with compact card (only when result is available)
    if (isExternalAgentTool(toolPart)) {
      const hasResult = (toolPart as Record<string, unknown>).output !== undefined || (toolPart as Record<string, unknown>).result !== undefined;
      if (hasResult) {
        const taskId = extractExternalAgentTaskId(
          toolPart as ToolPartLike & { result?: unknown; output?: unknown },
        )
        return (
          <ExternalAgentToolRenderer
            toolPart={toolPart}
            notificationInfo={taskId ? externalAgentNotificationsByTaskId?.get(taskId) : undefined}
          />
        );
      }
    }

    // Render Codex collab agent tool — use SubAgentRenderer if progress data available
    if (isCodexCollabAgentTool(toolPart)) {
      const codexProgress = getSubagentProgress(
        toolPart as ToolPartLike & { result?: unknown; output?: unknown },
      );
      if (codexProgress && codexProgress.recentActivity.length > 0) {
        const codexChildParts = convertSubagentToChildParts(codexProgress.recentActivity);
        const codexWrapped = {
          ...toolPart,
          state: mapSubagentState(codexProgress.state),
          args: {
            ...((toolPart.args ?? {}) as Record<string, unknown>),
            description: codexProgress.agentName,
          },
        };
        return (
          <SubAgentRenderer
            toolPart={codexWrapped}
            childParts={codexChildParts}
            messageId={message.id}
            partIndex={partIndex}
            onPermissionDecide={onPermissionDecide}
          />
        );
      }
      // Hide collab agent tool until sub-thread work begins (activities > 0)
      return null;
    }

    // Render OpenCode task (subagent) — reuse SubAgentRenderer
    if (isOpencodeSubtaskTool(toolPart)) {
      return (
        <SubAgentRenderer
          toolPart={toolPart}
          childParts={(childParts ?? []).map((cp) => {
            if (cp.type === 'tool-invocation' && 'toolInvocation' in cp) {
              return (cp as unknown as { toolInvocation: ToolPartLike }).toolInvocation;
            }
            return cp as unknown as ToolPartLike;
          })}
          messageId={message.id}
          partIndex={partIndex}
          onPermissionDecide={onPermissionDecide}
        />
      );
    }

    // Render Agent tool — all providers (CC, OpenCode, operon/custom, …) nest their
    // sub-agent tool steps into the main stream as child parts (bound via
    // providerMetadata.operon.parentToolCallId), rendered inline by SubAgentRenderer.
    if (toolName === 'Agent') {
      if (childParts) {
        return (
          <SubAgentRenderer
            toolPart={toolPart}
            childParts={childParts.map((cp) => {
              if (cp.type === 'tool-invocation' && 'toolInvocation' in cp) {
                return (cp as unknown as { toolInvocation: ToolPartLike }).toolInvocation;
              }
              return cp as unknown as ToolPartLike;
            })}
            messageId={message.id}
            partIndex={partIndex}
            onPermissionDecide={onPermissionDecide}
          />
        );
      }
    }

    // Render Gemini subagent progress — reuse SubAgentRenderer with converted data
    {
      const subagentProgress = getSubagentProgress(
        toolPart as ToolPartLike & { result?: unknown; output?: unknown },
      );
      if (subagentProgress) {
        const subagentChildParts = convertSubagentToChildParts(
          subagentProgress.recentActivity,
        );
        const wrappedToolPart = {
          ...toolPart,
          state: mapSubagentState(subagentProgress.state),
          args: {
            ...((toolPart.args ?? {}) as Record<string, unknown>),
            description: subagentProgress.agentName,
          },
        };
        return (
          <SubAgentRenderer
            toolPart={wrappedToolPart}
            childParts={subagentChildParts}
            messageId={message.id}
            partIndex={partIndex}
            onPermissionDecide={onPermissionDecide}
          />
        );
      }
    }

    return (
      <ToolInvocationRenderer
        toolPart={toolPart}
        messageId={message.id}
        partIndex={partIndex}
        onPermissionDecide={onPermissionDecide}
      />
    );
  }

  // Handle reasoning
  if (part.type === 'reasoning') {
    return (
      <Reasoning
        key={`${message.id}-${partIndex}`}
        className="w-full"
        defaultOpen={false}
        isStreaming={
          isStreamingMessage &&
          partIndex === message.parts.length - 1
        }
      >
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }

  // Handle attachments
  if (part.type === 'file' || part.type === 'source-document') {
    if (partIndex !== firstAttachmentIndex) return null;
    const attachmentsWithId = attachmentParts
      .filter((item): item is Extract<MessagePart, { type: 'file' | 'source-document' }> =>
        item.type === 'file' || item.type === 'source-document'
      )
      .map((item, index) => ({
        ...item,
        id: `${message.id}-attachment-${index}`,
      }));

    return (
      <Message key={`${message.id}-${partIndex}`} from={message.role}>
        <MessageContent>
          <Attachments className={cn(message.role === 'assistant' && 'ml-0')} variant="grid">
            {attachmentsWithId.map((file) => (
              <Attachment key={file.id} data={file}>
                <AttachmentPreview />
              </Attachment>
            ))}
          </Attachments>
        </MessageContent>
      </Message>
    );
  }

  // Handle text
  if (part.type !== 'text') return null;
  const displayText = part.text || '';
  if (!displayText.trim()) return null;

  // Compact rendering for background agent completion notifications
  if (message.role === 'user' && displayText.includes('<task-notification>')) {
    return (
      <div key={`${message.id}-${partIndex}`} className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
        <CheckCircle2Icon className="size-3.5 text-green-600 dark:text-green-400" />
        <span><FormattedMessage id="editor.msg.bgAgentCompleted" defaultMessage="Background agent completed" /></span>
      </div>
    );
  }

  // Compact rendering for external agent result notifications
  if (message.role === 'user' && isExternalAgentResultMessage(displayText)) {
    return <ExternalAgentResultRenderer key={`${message.id}-${partIndex}`} text={displayText} />;
  }

  // A workflow result the node delivered. It is a user-role message because that
  // is how the result reaches the model, but nobody typed it — render it as a
  // result card, not as something the user said.
  if (message.role === 'user' && isWorkflowResultMessage(displayText)) {
    return <WorkflowResultMessage key={`${message.id}-${partIndex}`} text={displayText} />;
  }

  // A teammate's message, delivered through the Teams hub. Same story as the workflow
  // result above — user-role on the wire, but another agent wrote it.
  const peer = extractPeerMessage(message);
  if (peer) {
    return <PeerMessage key={`${message.id}-${partIndex}`} from={peer.from} text={displayText} />;
  }

  const text = displayText;
  const isSteerMessage = isSteerUserMessage(message);

  // Split the context the user attached (selected text, line comments…) off
  // the front of the prompt, then parse skill tags from what remains.
  const { blocks: contextBlocks, body: userText } = message.role === 'user'
    ? parseContextBlocks(displayText)
    : { blocks: [], body: displayText };
  const { skills: skillTags, cleanText } = message.role === 'user'
    ? parseSkillTags(userText)
    : { skills: [], cleanText: displayText };

  return (
    <Message key={`${message.id}-${partIndex}`} from={message.role}>
      <MessageContent
        className={isSteerMessage ? 'bg-tint/20 text-foreground ring-1 ring-inset ring-tint/35 shadow-card' : undefined}
      >
        {message.role === 'user' && <UserContextBlocks blocks={contextBlocks} />}
        {skillTags.length > 0 && !isSteerMessage ? (
          <div className="flex items-baseline flex-wrap gap-1">
            {skillTags.map((name) => (
              <SkillTag key={name} name={name} />
            ))}
            {cleanText && <UserMessageText text={cleanText} />}
          </div>
        ) : message.role === 'user' ? (
          userText && <UserMessageText text={userText} />
        ) : (
          <MessageResponse mode={isStreamingMessage ? 'streaming' : 'static'}>
            {displayText}
          </MessageResponse>
        )}
      </MessageContent>
      {/* Assistant action row + turn footer render at the message level (see
          MessagesList) so they stay at the bottom even when the turn ends on a
          tool call. Only the user action row is anchored to its text part. */}
      {message.role === 'user' && partIndex === lastTextPartIndex && (
        <MessageActions className={cn('-ml-2.5 flex-row-reverse -mr-2.5 ml-0')}>
          <CopyButton text={text} onCopy={onCopy} />
          <SendToButton
            availableModels={availableModels}
            onSendTo={(modelId: string, providerId: string) => onSendTo(modelId, providerId, getMessageText(message))}
            onOpen={onSendToOpen}
          />
        </MessageActions>
      )}
    </Message>
  );
}
