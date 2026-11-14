// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useChatBackgroundTaskStore } from '@/stores/chat-background-task-store';
import { BackgroundNoticeList } from './MonitorNotices';
import { CompactToolCall } from './compact-tool/CompactToolCall';
import { ChatDbIdContext, ChatProviderIdContext } from './chat-db-id-context';
import { parseBackgroundNotices } from './background-notice';

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatBackgroundTaskStore.getState().sync([]);
});

const render = (node: ReactNode, providerId = 'claude-code') => act(() => {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ChatDbIdContext.Provider value={7}>
          <ChatProviderIdContext.Provider value={providerId}>{node}</ChatProviderIdContext.Provider>
        </ChatDbIdContext.Provider>
      </IntlProvider>
    </QueryClientProvider>,
  );
});

const event = (line: string) => `<task-notification>
<task-id>t1</task-id>
<summary>Monitor event: "e2e failures"</summary>
<event>${line}</event>
</task-notification>`;

describe('BackgroundNoticeList', () => {
  it('shows a single event by its first line', () => {
    render(<BackgroundNoticeList notices={parseBackgroundNotices(event('1) chat.spec.ts failed')) ?? []} />);
    const row = container.querySelector('[data-testid="monitor-event"]');
    expect(row?.textContent).toContain('e2e failures');
    expect(row?.textContent).toContain('1) chat.spec.ts failed');
  });

  it('folds a run of events into one counted row', () => {
    render(<BackgroundNoticeList notices={parseBackgroundNotices([event('a'), event('b'), event('c')].join('\n')) ?? []} />);
    const rows = container.querySelectorAll('[data-testid="monitor-event"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('3 events');
  });

  it('names a finished non-monitor task by its summary', () => {
    const text = '<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n<summary>Background command "build" failed (exit code 1)</summary>\n</task-notification>';
    render(<BackgroundNoticeList notices={parseBackgroundNotices(text) ?? []} />);
    const row = container.querySelector('[data-testid="task-notification"]');
    expect(row?.textContent).toBe('Background command "build" failed (exit code 1)');
    expect(row?.getAttribute('data-status')).toBe('error');
  });
});

describe('Monitor tool row', () => {
  const part = {
    type: 'dynamic-tool',
    toolName: 'Monitor',
    toolCallId: 'toolu_1',
    state: 'output-available',
    input: { command: 'tail -f app.log | grep --line-buffered ERROR', description: 'errors in app.log' },
    output: 'Monitor started (task t1, …)',
  };

  it('names the watch and shows it running while the task runs', () => {
    useChatBackgroundTaskStore.getState().set(7, [
      { taskId: 't1', toolUseId: 'toolu_1', taskType: 'monitor', backgrounded: true, description: 'errors in app.log', status: 'running', startedAt: 0 },
    ]);
    render(<CompactToolCall toolPart={part} messageId="m" partIndex={0} onPermissionDecide={async () => true} />);
    const line = container.querySelector('[data-slot="trace-line"]');
    expect(line?.getAttribute('data-status')).toBe('running');
    expect(line?.textContent).toContain('errors in app.log');
    expect(line?.textContent).not.toContain('tail -f');
    expect(container.querySelector('[data-testid="monitor-state"]')?.textContent).toBe('Watching');
  });

  it('says how the watch ended', () => {
    useChatBackgroundTaskStore.getState().set(7, [
      { taskId: 't1', toolUseId: 'toolu_1', taskType: 'monitor', backgrounded: true, description: 'errors in app.log', status: 'failed', startedAt: 0, endedAt: 1 },
    ]);
    render(<CompactToolCall toolPart={part} messageId="m" partIndex={0} onPermissionDecide={async () => true} />);
    expect(container.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status')).toBeNull();
    expect(container.querySelector('[data-testid="monitor-state"]')?.textContent).toBe('Failed');
  });

  it('falls back to the plain row with no task to read', () => {
    render(<CompactToolCall toolPart={part} messageId="m" partIndex={0} onPermissionDecide={async () => true} />);
    expect(container.querySelector('[data-testid="monitor-state"]')).toBeNull();
    expect(container.querySelector('[data-slot="trace-line"]')?.textContent).toContain('errors in app.log');
  });
});
