import { Children, isValidElement, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { MessageResponse } from '@/components/ai-elements/message';
import { MessagePartRenderer } from './MessagePartRenderer';

const codeBlock = '```text\nAgentService → IConfigService\n```';

function findMessageResponse(node: ReactNode): React.ReactElement | null {
  if (!isValidElement(node)) return null;
  if (node.type === MessageResponse) return node;

  const props = node.props as { children?: ReactNode };
  for (const child of Children.toArray(props.children)) {
    const response = findMessageResponse(child);
    if (response) return response;
  }

  return null;
}

function renderAssistantText(isStreamingMessage: boolean) {
  const message: UIMessage = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: codeBlock }],
  };

  return MessagePartRenderer({
    message,
    part: message.parts[0],
    partIndex: 0,
    isStreamingMessage,
    onPermissionDecide: async () => true,
    onCopy: () => undefined,
    onSendTo: () => undefined,
    availableModels: [],
    getMessageText: () => codeBlock,
    firstAttachmentIndex: -1,
    attachmentParts: [],
    lastTextPartIndex: 0,
    SendToButton: () => <></>,
  });
}

describe('assistant message response mode', () => {
  it.each([
    { isStreaming: true, expectedMode: 'streaming' },
    { isStreaming: false, expectedMode: 'static' },
  ] as const)(
    'uses $expectedMode mode when isStreamingMessage is $isStreaming',
    ({ isStreaming, expectedMode }) => {
      const response = findMessageResponse(renderAssistantText(isStreaming));

      expect(response).not.toBeNull();
      expect(response?.props).toMatchObject({
        children: codeBlock,
        mode: expectedMode,
      });
    },
  );

  it('uses React default memo comparison so a mode-only change can render', () => {
    expect((MessageResponse as unknown as { compare: unknown }).compare).toBeNull();
  });
});
