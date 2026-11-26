// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent, within } from '@testing-library/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { EnvironmentPicker } from './DraftChatBar';
import { useEditorStore } from '@/stores/editor-store';
import { requestVia } from '@/lib/api-client';

vi.mock('@/lib/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api-client')>(), requestVia: vi.fn(),
}));

it('keeps the local default, uses the saved host name, and locks changes during a turn', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const tabId = 'env-picker-test';
  const host = { id: 'build-id', name: 'Mac mini', cwd: '/build' };
  const previous = useEditorStore.getState().tabs;
  useEditorStore.setState({ tabs: [{ id: tabId, title: 'Chat', type: 'chat', providerId: 'custom' }] });
  let attached = false;
  let offline = true;
  vi.mocked(requestVia).mockImplementation(async (_transport, path, options) => {
    if (path.endsWith('/chats/7')) {
      if (options?.method === 'PATCH') {
        if (offline) throw new Error('Mac mini is offline.');
        attached = JSON.parse(String(options.body)).add === true;
      }
      return attached ? [host] : [];
    }
    if (path.endsWith('/test')) return { success: true };
    return [host];
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (busy = false, chatId?: number, selected?: { id: string; name: string }) => act(async () => {
    root.render(<QueryClientProvider client={client}>
      <EnvironmentPicker tabId={tabId} chatId={chatId} selected={selected} busy={busy} isMobile={false} localDir="/project" />
    </QueryClientProvider>);
  });
  const screen = within(document.body);
  try {
    await render();
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'Execution environment' }), { key: 'ArrowDown' }); });
    const option = await screen.findByRole('menuitemcheckbox', { name: /Mac mini/ });
    await act(async () => { fireEvent.click(option); });
    expect(useEditorStore.getState().tabs[0].additionalSshEnvironments).toEqual([{ id: host.id, name: host.name }]);
    expect(screen.getByRole('button', { hidden: true, name: 'Execution environment' }).textContent).toBe('Local +1');
    await render(true, 7);
    expect(screen.getByText('You can change environments after this response.')).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: /Mac mini/ }).getAttribute('aria-disabled')).toBe('true');
    await render(false, 7);
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Mac mini/ })); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Mac mini is offline.');
    offline = false;
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' })); });
    expect(attached).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Mac mini/ })); });
    expect(attached).toBe(false);
    await render(false, undefined, host);
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Local/ })); });
    expect(useEditorStore.getState().tabs[0].additionalSshEnvironments).toContainEqual({ id: 'local', name: 'Local', cwd: '/project' });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Local/ })); });
    expect(useEditorStore.getState().tabs[0].additionalSshEnvironments?.some(ref => ref.id === 'local')).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
    client.clear();
    useEditorStore.setState({ tabs: previous });
  }
});
