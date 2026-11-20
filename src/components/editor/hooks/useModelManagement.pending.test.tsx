// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerKeys, type ProviderModelsResponse } from '@/lib/provider-queries';
import { useModelManagement } from './useModelManagement';

vi.mock('@/lib/api', () => ({ api: { getProviderModels: vi.fn(() => new Promise(() => {})) } }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function Picker() {
  const { currentMode } = useModelManagement('', 'claude-code', { modeId: 'auto' });
  return <span>{currentMode || 'none'}</span>;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
});

describe('remembered chat options', () => {
  it('keeps the last-used mode when the catalog is still warming at mount', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } });

    // The agent is still starting: no models yet, only the bare default mode.
    const warming: ProviderModelsResponse = {
      modelsPending: true,
      modes: [{ id: 'default', name: 'Default' }],
      currentModeId: 'default',
    };
    client.setQueryData(providerKeys.models('claude-code'), warming);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Picker /></QueryClientProvider>);
    });
    expect(container.textContent).toBe('none');

    const ready: ProviderModelsResponse = {
      models: [{ modelId: 'opus', name: 'Opus' }],
      modes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }],
      currentModeId: 'default',
    };
    await act(async () => {
      client.setQueryData(providerKeys.models('claude-code'), ready);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('auto');
  });
});
