import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessagesList } from './MessagesList';

// Server rendering reads a zustand store's initial state, so the setting is mocked.
const display = vi.hoisted(() => ({ conciseMode: false }));
vi.mock('@/stores/chat-display-store', () => ({
  useChatDisplayStore: <T,>(select: (state: { conciseMode: boolean }) => T) => select(display),
}));

vi.mock('@/components/ai-elements/conversation', () => ({
  ConversationItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ai-elements/rich-markdown', () => ({
  RichMarkdown: ({ children }: { children?: ReactNode }) => <div data-testid="md">{children}</div>,
}));

const reply: UIMessage = {
  id: 'a1',
  role: 'assistant',
  metadata: { turnStartedAt: 1_000, turnEndedAt: 1_000 + 287_000 },
  parts: [
    { type: 'text', text: 'Looking into it first.' },
    { type: 'dynamic-tool', toolName: 'Read', toolCallId: 't1', state: 'output-available', input: { file_path: 'a.ts' }, output: 'x' },
    { type: 'text', text: 'All done, the final answer.' },
  ],
};

function render(messages: UIMessage[], status = 'ready') {
  return renderToStaticMarkup(
    <IntlProvider locale="en">
      <MessagesList
        messages={messages}
        status={status}
        onPermissionDecide={async () => true}
        onSendTo={() => undefined}
        onSendToTab={() => undefined}
        currentChatId="c"
        availableModels={[]}
      />
    </IntlProvider>,
  );
}

const user: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }] };

describe('concise mode', () => {
  afterEach(() => { display.conciseMode = false; });

  it('shows every step when off', () => {
    const html = render([user, reply]);
    expect(html).not.toContain('turn-work-fold');
    expect(html).toContain('Looking into it first.');
  });

  it('folds the work before the final text behind its duration', () => {
    display.conciseMode = true;
    const html = render([user, reply]);
    expect(html).toContain('Worked for 4m 47s');
    // Radix unmounts closed content: the intermediate prose is not rendered.
    expect(html).not.toContain('Looking into it first.');
    expect(html).toContain('All done, the final answer.');
  });

  it.each([false, true])('keeps the external agent visible once when folded (Code Mode: %s)', (inProgram) => {
    display.conciseMode = true;
    const program: UIMessage['parts'][number] = {
      type: 'dynamic-tool', toolName: 'RunCode', toolCallId: 'program', state: 'output-available', input: {}, output: 'ok',
    };
    const agent: UIMessage['parts'][number] = {
      type: 'dynamic-tool', toolName: 'external_agent_run', toolCallId: 'agent', state: 'output-available',
      input: { description: 'Prepare TestFlight build' }, output: { agent_id: 'ext-1', chat_id: 42 },
      ...(inProgram && { callProviderMetadata: { codex: { programToolCallId: 'program' } } }),
    };
    const html = render([user, { ...reply, parts: [reply.parts[0], ...(inProgram ? [program] : []), agent, reply.parts[2]] }]);
    expect(html).toContain('Worked for 4m 47s');
    expect(html).not.toContain('Looking into it first.');
    expect(html.match(/Prepare TestFlight build/g)).toHaveLength(1);
    expect(html.indexOf('Prepare TestFlight build')).toBeLessThan(html.indexOf('All done, the final answer.'));
  });

  it('leaves a reply that is still streaming unfolded', () => {
    display.conciseMode = true;
    const html = render([user, reply], 'streaming');
    expect(html).not.toContain('turn-work-fold');
  });

  it('keeps an approval waiting before the final text in view', () => {
    display.conciseMode = true;
    const waiting: UIMessage = {
      ...reply,
      parts: [
        { type: 'dynamic-tool', toolName: 'Bash', toolCallId: 't2', state: 'approval-requested', input: { command: 'rm x' }, approval: { id: 'p1' } },
        { type: 'text', text: 'Waiting on you.' },
      ],
    };
    expect(render([user, waiting])).not.toContain('turn-work-fold');
  });
});
