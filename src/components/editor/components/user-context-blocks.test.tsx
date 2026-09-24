import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { wrapContextBlock } from '@/lib/context-blocks';
import { MessagePartRenderer } from './MessagePartRenderer';

function renderUserText(text: string) {
  const message: UIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text }] };
  return renderToStaticMarkup(
    <IntlProvider locale="en">
      <MessagePartRenderer
        message={message}
        part={message.parts[0]}
        partIndex={0}
        isStreamingMessage={false}
        onPermissionDecide={async () => true}
        onCopy={() => undefined}
        onSendTo={() => undefined}
        availableModels={[]}
        getMessageText={() => text}
        firstAttachmentIndex={-1}
        attachmentParts={[]}
        lastTextPartIndex={0}
        SendToButton={() => <></>}
      />
    </IntlProvider>,
  );
}

const quote = wrapContextBlock('selected-text.md', 'Selected from `a.md`:\n\n> agent-harness.ts');

describe('user message context blocks', () => {
  it('renders attached context as cards and only the prompt as text', () => {
    const html = renderUserText(`${quote}\n\n[skill:review] what does this do?`);

    expect(html).toContain('Selected text');
    expect(html).toContain('a.md');
    expect(html).toContain('what does this do?');
    expect(html).not.toContain('[skill:review]');
  });

  it('renders a plain prompt unchanged', () => {
    const html = renderUserText('hello');

    expect(html).toContain('hello');
    expect(html).not.toContain('Selected text');
  });
});
