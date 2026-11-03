// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useCodexUsagePolling } from './useCodexUsagePolling';
import type { CodexRateLimits } from '../utils/chatMetadata';

vi.mock('@/lib/api', () => ({ api: { aiGetCodexUsage: vi.fn() } }));

const rateLimits: CodexRateLimits = { rateLimits: {
  limitId: 'codex', limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
  secondary: null, credits: null, planType: 'pro',
} };
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function Usage({ generating = false }: { generating?: boolean }) {
  const { data } = useCodexUsagePolling(true, generating);
  return <span>{data?.rateLimits?.primary?.usedPercent ?? 'loading'}</span>;
}

async function render(generating = false) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Usage generating={generating} /></QueryClientProvider>);
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.clearAllMocks();
});

function setup() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.aiGetCodexUsage).mockResolvedValue({ success: true, data: rateLimits });
}

describe('Codex account usage', () => {
  it('loads quota without a chat id or any messages', async () => {
    setup();
    await render();
    await act(async () => {
      await vi.waitFor(() => expect(client.getQueryData(['ai', 'codex-usage'])).toEqual(rateLimits));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('12');
    expect(api.aiGetCodexUsage).toHaveBeenCalledTimes(1);
  });

  it('reuses the top bar account cache on a new chat', async () => {
    setup();
    client.setQueryData(['ai', 'codex-usage'], rateLimits);
    await render();
    expect(container.textContent).toBe('12');
    expect(api.aiGetCodexUsage).not.toHaveBeenCalled();
  });

  it('refreshes when a turn finishes', async () => {
    setup();
    client.setQueryData(['ai', 'codex-usage'], rateLimits);
    await render(true);
    await render(false);
    expect(api.aiGetCodexUsage).toHaveBeenCalledTimes(1);
  });
});
