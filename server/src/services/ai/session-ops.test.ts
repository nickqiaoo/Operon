import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUsageLimits } from '@operon/agent-runtime';

const stateMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  destroySession: vi.fn(async () => undefined),
  finishRequest: vi.fn(),
  getOrCreate: vi.fn(),
  getChatMeta: vi.fn(),
  isAgentOwnedChat: vi.fn(() => false),
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
    destroy: stateMock.destroySession,
    finishRequest: stateMock.finishRequest,
    getOrCreate: stateMock.getOrCreate,
  }),
  getChatStorage: () => ({ getChatMeta: stateMock.getChatMeta }),
  getProjectStorage: () => null,
  getRuntime: () => ({
    native: () => ({ accountUsage: runtimeMock.getClaudeAccountUsage, peekAccountUsage: () => null }),
  }),
}));

vi.mock('./helpers.js', () => ({
  createSteerUserMessage: helpersMock.createSteerUserMessage,
}));

vi.mock('./persistence.js', () => ({
  persistInjectedUserMessageWithRetry: persistenceMock.persistInjectedUserMessageWithRetry,
}));

vi.mock('../channel/agent-orchestrator.js', () => ({
  isAgentOwnedChat: stateMock.isAgentOwnedChat,
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
      runtime: { inject: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue(steerMessage);
    persistenceMock.persistInjectedUserMessageWithRetry.mockReturnValue({ success: true });
    const { injectIntoChat } = await loadSessionOps();

    await expect(injectIntoChat(7, ' Focus on edge cases ', 'user-1')).resolves.toEqual({
      success: true,
      delivery: 'accepted',
      message: steerMessage,
    });
    expect(injectMessage).toHaveBeenCalledWith('Focus on edge cases', { id: expect.any(String) });
    const [{ id: injectedId }] = injectMessage.mock.calls[0].slice(1) as [{ id: string }];
    expect(helpersMock.createSteerUserMessage).toHaveBeenCalledWith(
      'Focus on edge cases',
      'user-1',
      injectedId,
    );
    expect(persistenceMock.persistInjectedUserMessageWithRetry).toHaveBeenCalledWith(
      7,
      steerMessage,
    );
  });

  it('uses the client-chosen id for both the injection and the steer message', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1' }, runtime: { inject: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer-abc', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessageWithRetry.mockReturnValue({ success: true });
    const { injectIntoChat } = await loadSessionOps();
    await injectIntoChat(7, 'result', undefined, { messageId: 'steer-abc' });
    expect(injectMessage).toHaveBeenCalledWith('result', { id: 'steer-abc' });
    expect(helpersMock.createSteerUserMessage).toHaveBeenCalledWith('result', undefined, 'steer-abc');
  });

  it('distinguishes accepted injection from a failed transcript save', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1' }, runtime: { inject: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessageWithRetry.mockReturnValue({ success: false, error: 'disk full' });
    const { injectIntoChat } = await loadSessionOps();
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ success: false, delivery: 'accepted', error: 'disk full' });
    expect(injectMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a definite provider rejection retryable', async () => {
    const injectMessage = vi.fn();
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'request' }, runtime: { inject: injectMessage } });
    const { injectIntoChat } = await loadSessionOps();
    const { RuntimeInjectionUnavailableError } = await import('@operon/agent-runtime');
    injectMessage.mockRejectedValue(new RuntimeInjectionUnavailableError('Not ready'));
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ delivery: 'not-sent' });
  });

  it('does not inject into a replacement request and treats provider errors as uncertain', async () => {
    const injectMessage = vi.fn().mockRejectedValue(new Error('connection lost'));
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'new-request' }, runtime: { inject: injectMessage },
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


describe('handleSessionCleanup', () => {
  beforeEach(() => {
    stateMock.destroySession.mockClear();
    stateMock.getChatMeta.mockReset();
    stateMock.isAgentOwnedChat.mockReset().mockReturnValue(false);
  });

  it.each([
    { tp: 'workflow-agent' },
    { tp: 'chat', metadata: { workflowAgent: { runId: 'spec-1', index: 0 } } },
    { tp: 'chat', metadata: { externalAgent: true } },
  ])('leaves an orchestrated agent running when its viewing tab closes: %j', async (meta) => {
    stateMock.getChatMeta.mockReturnValue(meta);
    const { handleSessionCleanup } = await loadSessionOps();
    expect(handleSessionCleanup(7)).toBe(true);
    expect(stateMock.destroySession).not.toHaveBeenCalled();
  });

  it('leaves task-owned coordinator and implementer sessions running', async () => {
    stateMock.isAgentOwnedChat.mockReturnValue(true);
    const { handleSessionCleanup } = await loadSessionOps();
    expect(handleSessionCleanup(7)).toBe(true);
    expect(stateMock.isAgentOwnedChat).toHaveBeenCalledWith(7);
    expect(stateMock.destroySession).not.toHaveBeenCalled();
  });

  it('still cleans up an ordinary chat when its last tab closes', async () => {
    stateMock.getChatMeta.mockReturnValue({ tp: 'chat' });
    const { handleSessionCleanup } = await loadSessionOps();
    expect(handleSessionCleanup(7)).toBe(true);
    expect(stateMock.destroySession).toHaveBeenCalledWith(7);
  });

  it('still allows an explicit Stop to abort an orchestrated session', async () => {
    const abort = vi.fn();
    stateMock.isAgentOwnedChat.mockReturnValue(true);
    stateMock.getSession.mockReturnValue({ runtime: { abort } });
    const { abortChat } = await loadSessionOps();
    abortChat(7);
    expect(abort).toHaveBeenCalledOnce();
  });
});


describe('goal controls', () => {
  it('persists pause before aborting the stream and returns the authoritative goal', async () => {
    const controller = new AbortController();
    const goal = { objective: 'Finish', status: 'paused', tokensUsed: 120 };
    const setStatus = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(false);
      return goal;
    });
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'r', abortController: controller }, runtime: { goal: { setStatus } } });
    const { setChatGoalStatus } = await loadSessionOps();
    await expect(setChatGoalStatus(7, 'paused')).resolves.toEqual({ success: true, goal });
    expect(controller.signal.aborted).toBe(true);
    expect(setStatus).toHaveBeenCalledWith('paused');
  });

  it('clears the persisted goal before abort so a delayed pause cannot recreate it', async () => {
    const controller = new AbortController();
    const clear = vi.fn(async () => { expect(controller.signal.aborted).toBe(false); });
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'r', abortController: controller }, runtime: { goal: { clear } } });
    const { clearChatGoal } = await loadSessionOps();
    await expect(clearChatGoal(7)).resolves.toEqual({ success: true });
    expect(clear).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });
});


it('rehydrates a persisted Codex goal without requiring an already open session', async () => {
  stateMock.getSession.mockReturnValue(undefined);
  stateMock.getChatMeta.mockReturnValue({ providerId: 'codex', sessionId: 'thread-stored', model: 'gpt-5' });
  const goal = { objective: 'Finish', status: 'paused', tokensUsed: 120 };
  stateMock.getOrCreate.mockResolvedValue({ runtime: { goal: { get: async () => goal } } });
  const { getChatGoal } = await loadSessionOps();
  await expect(getChatGoal(7)).resolves.toEqual({ success: true, goal });
  expect(stateMock.getOrCreate).toHaveBeenCalledWith(7, 'codex', expect.objectContaining({ resume: 'thread-stored', model: 'gpt-5' }));
});
