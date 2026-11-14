// @vitest-environment jsdom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolCallGroup } from './ToolCallGroup';

type Part = UIMessage['parts'][number];

const tool = (toolCallId: string, state: string, extra: Record<string, unknown> = {}): Part =>
  ({ type: 'dynamic-tool', toolCallId, toolName: 'Bash', state, input: { command: 'ls' }, ...extra }) as unknown as Part;

const settled = [tool('a', 'output-available', { output: 'ok' }), tool('b', 'output-available', { output: 'ok' })];
const awaiting = [tool('a', 'output-available', { output: 'ok' }), tool('b', 'approval-requested', { approval: { id: 'ap-1' } })];

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (parts: Part[]) => act(() => {
  root.render(
    <IntlProvider locale="en">
      <ToolCallGroup
        parts={parts}
        partIndices={parts.map((_, i) => i)}
        messageId="m1"
        onPermissionDecide={async () => true}
        renderProgram={() => null}
      />
    </IntlProvider>,
  );
});

// The group's own trigger is the first collapsible trigger in the tree.
const groupTrigger = () => container.querySelector<HTMLElement>('[aria-expanded]')!;
const isOpen = () => groupTrigger().getAttribute('aria-expanded') === 'true';

describe('ToolCallGroup approval folding', () => {
  it('opens for a new approval and folds again once it is settled', () => {
    render(settled);
    expect(isOpen()).toBe(false);
    render(awaiting);
    expect(isOpen()).toBe(true);
    render(settled);
    expect(isOpen()).toBe(false);
  });

  it('lets the person fold the group while the part still reads approval-requested', () => {
    render(settled);
    render(awaiting);
    expect(isOpen()).toBe(true);
    act(() => groupTrigger().click());
    expect(isOpen()).toBe(false);
  });

  it('stays open after the approval when the person opened it themselves', () => {
    render(settled);
    act(() => groupTrigger().click());
    render(awaiting);
    render(settled);
    expect(isOpen()).toBe(true);
  });
});
