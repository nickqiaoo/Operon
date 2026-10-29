import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { MessageResponse } from '@/components/ai-elements/message';
import { MessagePartRenderer } from './MessagePartRenderer';

const codeBlock = '```text\nAgentService → IConfigService\n```';

vi.mock('streamdown', async () => {
  const actual = await vi.importActual<typeof import('streamdown')>('streamdown');
  return {
    ...actual,
    Streamdown: ({ children, mode, isAnimating, parseIncompleteMarkdown }: {
      children?: ReactNode;
      mode?: 'static' | 'streaming';
      isAnimating?: boolean;
      parseIncompleteMarkdown?: boolean;
    }) => (
      <div data-mode={mode} data-animating={String(isAnimating)} data-incomplete={String(parseIncompleteMarkdown)}>
        {children}
      </div>
    ),
  };
});

function renderAssistantText(isStreamingMessage: boolean) {
  const message: UIMessage = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: codeBlock }],
  };

  return renderToStaticMarkup(
    <IntlProvider locale="en">
      <MessagePartRenderer
        message={message}
        part={message.parts[0]}
        partIndex={0}
        isStreamingMessage={isStreamingMessage}
        onPermissionDecide={async () => true}
        onCopy={() => undefined}
        onSendTo={() => undefined}
        availableModels={[]}
        getMessageText={() => codeBlock}
        firstAttachmentIndex={-1}
        attachmentParts={[]}
        lastTextPartIndex={0}
        SendToButton={() => <></>}
      />
    </IntlProvider>,
  );
}

describe('assistant message response mode', () => {
  // Always the streaming renderer: switching to Streamdown's static mode when a
  // reply finished swapped its whole tree and rebuilt the message.
  it.each([true, false])(
    'keeps streaming mode and flags the stream state when isStreamingMessage is %s',
    (isStreaming) => {
      const html = renderAssistantText(isStreaming);

      expect(html).toContain('data-mode="streaming"');
      expect(html).toContain(`data-animating="${isStreaming}"`);
      expect(html).toContain(`data-incomplete="${isStreaming}"`);
      expect(html).toContain(codeBlock);
    },
  );

  it('uses React default memo comparison so a mode-only change can render', () => {
    expect((MessageResponse as unknown as { compare: unknown }).compare).toBeNull();
  });
});
