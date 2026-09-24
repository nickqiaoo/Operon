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
    Streamdown: ({ children, mode }: { children?: ReactNode; mode?: 'static' | 'streaming' }) => (
      <div data-mode={mode}>{children}</div>
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
  it.each([
    { isStreaming: true, expectedMode: 'streaming' },
    { isStreaming: false, expectedMode: 'static' },
  ] as const)(
    'uses $expectedMode mode when isStreamingMessage is $isStreaming',
    ({ isStreaming, expectedMode }) => {
      const html = renderAssistantText(isStreaming);

      expect(html).toContain(`data-mode="${expectedMode}"`);
      expect(html).toContain(codeBlock);
    },
  );

  it('uses React default memo comparison so a mode-only change can render', () => {
    expect((MessageResponse as unknown as { compare: unknown }).compare).toBeNull();
  });
});
