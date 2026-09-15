import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUsageLimits } from '@operon/agent-runtime';

const stateMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const runtimeMock = vi.hoisted(() => ({
  getClaudeAccountUsage: vi.fn(),
}));

const helpersMock = vi.hoisted(() => ({
  createSteerUserMessage: vi.fn(),
}));

const persistenceMock = vi.hoisted(() => ({
  persistInjectedUserMessageWithRetry: vi.fn(),
}));

vi.mock('./state.js', () => ({
  getSessionManager: () => ({
    get: stateMock.getSession,
  }),
}));

vi.mock('@operon/agent-runtime', async (original) => ({
  ...await original<typeof import('@operon/agent-runtime')>(),
  getClaudeAccountUsage: runtimeMock.getClaudeAccountUsage,
}));

vi.mock('./helpers.js', () => ({
  createSteerUserMessage: helpersMock.createSteerUserMessage,
}));

vi.mock('./persistence.js', () => ({
  persistInjectedUserMessageWithRetry: persistenceMock.persistInjectedUserMessageWithRetry,
}));

vi.mock('../channel/agent-orchestrator.js', () => ({
  isAgentOwnedChat: () => false,
}));

const usage: RuntimeUsageLimits = {
  windows: {
    five_hour: {
      status: 'allowed',
      utilization: 42,
      resetsAt: 1_800_000_000,
    },
  },
  subscriptionType: 'max',
};

async function loadSessionOps() {
  vi.resetModules();
  return import('./session-ops.js');
}

describe('injectIntoChat', () => {
  beforeEach(() => {
    stateMock.getSession.mockReset();
    helpersMock.createSteerUserMessage.mockReset();
    persistenceMock.persistInjectedUserMessageWithRetry.mockReset();
  });

  it('returns the durable steer message with its target turn metadata', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    const steerMessage = {
      id: 'steer-1',
      role: 'user' as const,
      metadata: { steer: true, turnMessageId: 'user-1' },
      parts: [{ type: 'text' as const, text: 'Focus on edge cases' }],
    };
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1', abortController: new AbortController() },
      runtime: { injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue(steerMessage);
    persistenceMock.persistInjectedUserMessageWithRetry.mockReturnValue({ success: true });
    const { injectIntoChat } = await loadSessionOps();

    await expect(injectIntoChat(7, ' Focus on edge cases ', 'user-1')).resolves.toEqual({
      success: true,
      delivery: 'accepted',
      message: steerMessage,
    });
    expect(injectMessage).toHaveBeenCalledWith('Focus on edge cases');
    expect(helpersMock.createSteerUserMessage).toHaveBeenCalledWith(
      'Focus on edge cases',
      'user-1',
    );
    expect(persistenceMock.persistInjectedUserMessageWithRetry).toHaveBeenCalledWith(
      7,
      steerMessage,
    );
  });

  it('distinguishes accepted injection from a failed transcript save', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1' }, runtime: { injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessageWithRetry.mockReturnValue({ success: false, error: 'disk full' });
    const { injectIntoChat } = await loadSessionOps();
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ success: false, delivery: 'accepted', error: 'disk full' });
    expect(injectMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a definite provider rejection retryable', async () => {
    const injectMessage = vi.fn();
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'request' }, runtime: { injectMessage } });
    const { injectIntoChat } = await loadSessionOps();
    const { RuntimeInjectionUnavailableError } = await import('@operon/agent-runtime');
    injectMessage.mockRejectedValue(new RuntimeInjectionUnavailableError('Not ready'));
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ delivery: 'not-sent' });
  });

  it('does not inject into a replacement request and treats provider errors as uncertain', async () => {
    const injectMessage = vi.fn().mockRejectedValue(new Error('connection lost'));
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'new-request' }, runtime: { injectMessage },
    });
    const { injectIntoChat } = await loadSessionOps();
    await expect(injectIntoChat(7, 'result', undefined, { expectedRequestId: 'old-request' }))
      .resolves.toMatchObject({ delivery: 'not-sent' });
    expect(injectMessage).not.toHaveBeenCalled();
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ delivery: 'unknown' });
    expect(persistenceMock.persistInjectedUserMessageWithRetry).not.toHaveBeenCalled();
  });

});

describe('getClaudeUsageLimits', () => {
  beforeEach(() => {
    stateMock.getSession.mockReset();
    runtimeMock.getClaudeAccountUsage.mockReset();
  });

  it('needs no chat session — it reads the account-level probe', async () => {
    runtimeMock.getClaudeAccountUsage.mockResolvedValue(usage);
    stateMock.getSession.mockReturnValue(undefined);
    const { getClaudeUsageLimits } = await loadSessionOps();

    await expect(getClaudeUsageLimits()).resolves.toEqual({ success: true, data: usage });
  });

  it('shares one in-flight probe request across concurrent callers', async () => {
    let resolveUsage!: (value: RuntimeUsageLimits) => void;
    runtimeMock.getClaudeAccountUsage.mockReturnValue(
      new Promise<RuntimeUsageLimits>((resolve) => {
        resolveUsage = resolve;
      }),
    );
    const { getClaudeUsageLimits } = await loadSessionOps();

    const first = getClaudeUsageLimits();
    const second = getClaudeUsageLimits();
    expect(runtimeMock.getClaudeAccountUsage).toHaveBeenCalledTimes(1);

    resolveUsage(usage);
    await expect(first).resolves.toEqual({ success: true, data: usage });
    await expect(second).resolves.toEqual({ success: true, data: usage });
  });

  it('serves a recent snapshot without hitting the probe again', async () => {
    runtimeMock.getClaudeAccountUsage.mockResolvedValue(usage);
    const { getClaudeUsageLimits } = await loadSessionOps();

    await expect(getClaudeUsageLimits()).resolves.toEqual({ success: true, data: usage });
    await expect(getClaudeUsageLimits()).resolves.toEqual({ success: true, data: usage });
    expect(runtimeMock.getClaudeAccountUsage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the last snapshot when the probe fails', async () => {
    vi.useFakeTimers();
    try {
      runtimeMock.getClaudeAccountUsage.mockResolvedValueOnce(usage);
      const { getClaudeUsageLimits } = await loadSessionOps();
      await expect(getClaudeUsageLimits()).resolves.toEqual({ success: true, data: usage });

      vi.advanceTimersByTime(60_000);
      runtimeMock.getClaudeAccountUsage.mockRejectedValueOnce(new Error('probe died'));
      await expect(getClaudeUsageLimits()).resolves.toEqual({ success: true, data: usage });
    } finally {
      vi.useRealTimers();
    }
  });
});
