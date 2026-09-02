import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { wrapContextBlock } from '@/lib/context-blocks';
import { MessagePartRenderer } from './MessagePartRenderer';
import { UserContextBlocks } from './UserContextBlocks';
import { UserMessageText } from './UserMessageText';

function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  const props = node.props as { children?: ReactNode };
  for (const child of Children.toArray(props.children)) findAll(child, type, out);
  return out;
}

function renderUserText(text: string) {
  const message: UIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text }] };
  return MessagePartRenderer({
    message,
    part: message.parts[0],
    partIndex: 0,
    isStreamingMessage: false,
    onPermissionDecide: async () => true,
    onCopy: () => undefined,
    onSendTo: () => undefined,
    availableModels: [],
    getMessageText: () => text,
    firstAttachmentIndex: -1,
    attachmentParts: [],
    lastTextPartIndex: 0,
    SendToButton: () => <></>,
  });
}

const quote = wrapContextBlock('selected-text.md', 'Selected from `a.md`:\n\n> agent-harness.ts');

describe('user message context blocks', () => {
  it('renders attached context as cards and only the prompt as text', () => {
    const tree = renderUserText(`${quote}\n\n[skill:review] what does this do?`);
    const cards = findAll(tree, UserContextBlocks);
    expect(cards).toHaveLength(1);
    expect(cards[0].props).toMatchObject({
      blocks: [{ filename: 'selected-text.md', content: 'Selected from `a.md`:\n\n> agent-harness.ts' }],
    });
    const texts = findAll(tree, UserMessageText);
    expect(texts.map((t) => (t.props as { text: string }).text)).toEqual(['what does this do?']);
  });

  it('renders a plain prompt unchanged', () => {
    const tree = renderUserText('hello');
    expect((findAll(tree, UserContextBlocks)[0].props as { blocks: unknown[] }).blocks).toEqual([]);
    expect((findAll(tree, UserMessageText)[0].props as { text: string }).text).toBe('hello');
  });
});
