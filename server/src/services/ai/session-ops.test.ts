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
  persistInjectedUserMessage: vi.fn(),
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
  persistInjectedUserMessage: persistenceMock.persistInjectedUserMessage,
}));

const liveTurnMock = vi.hoisted(() => ({
  getLiveTurn: vi.fn<(chatId: number) => { isDone: boolean } | undefined>(() => undefined),
}));

vi.mock('./live-turn-hub.js', () => ({
  getLiveTurn: liveTurnMock.getLiveTurn,
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
    persistenceMock.persistInjectedUserMessage.mockReset();
    liveTurnMock.getLiveTurn.mockReset();
  });

  it('returns the durable steer message with its target turn metadata', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    const steerMessage = {
      id: 'steer-1',
      role: 'user' as const,
      metadata: { steer: true, turnMessageId: 'user-1', deliveryMode: 'steer' },
      parts: [{ type: 'text' as const, text: 'Focus on edge cases' }],
    };
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1', abortController: new AbortController() },
      runtime: { steer: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue(steerMessage);
    persistenceMock.persistInjectedUserMessage.mockReturnValue({ success: true });
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
    expect(persistenceMock.persistInjectedUserMessage).toHaveBeenCalledWith(
      7,
      steerMessage,
    );
  });

  it('uses the client-chosen id for both the injection and the steer message', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1' }, runtime: { steer: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer-abc', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessage.mockReturnValue({ success: true });
    const { injectIntoChat } = await loadSessionOps();
    await injectIntoChat(7, 'result', undefined, { messageId: 'steer-abc' });
    expect(injectMessage).toHaveBeenCalledWith('result', { id: 'steer-abc' });
    expect(helpersMock.createSteerUserMessage).toHaveBeenCalledWith('result', undefined, 'steer-abc');
  });

  it('distinguishes accepted injection from a failed transcript save', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'request-1' }, runtime: { steer: injectMessage },
    });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessage.mockReturnValue({ success: false, error: 'disk full' });
    const { injectIntoChat } = await loadSessionOps();
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ success: false, delivery: 'accepted', error: 'disk full' });
    expect(injectMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a definite provider rejection retryable', async () => {
    const injectMessage = vi.fn();
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'request' }, runtime: { steer: injectMessage } });
    const { injectIntoChat } = await loadSessionOps();
    const { RuntimeInjectionUnavailableError } = await import('@operon/agent-runtime');
    injectMessage.mockRejectedValue(new RuntimeInjectionUnavailableError('Not ready'));
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ delivery: 'not-sent' });
  });

  it('lets auto fall back to followup only after a definite steer rejection', async () => {
    const { injectIntoChat } = await loadSessionOps();
    const { RuntimeInjectionUnavailableError } = await import('@operon/agent-runtime');
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessage.mockReturnValue({ success: true });
    const steer = vi.fn().mockRejectedValue(new RuntimeInjectionUnavailableError('between turns'));
    const followup = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({ activeRequest: { requestId: 'request' }, runtime: { steer, followup } });

    const auto = await injectIntoChat(7, 'note', undefined, { mode: 'auto', messageId: 'id-1' });
    expect(auto).toMatchObject({ success: true, delivery: 'accepted', message: { metadata: { deliveryMode: 'followup' } } });
    expect(followup).toHaveBeenCalledWith('note', { id: 'id-1' });

    followup.mockClear();
    expect(await injectIntoChat(7, 'note', undefined, { mode: 'steer' })).toMatchObject({ success: false, delivery: 'not-sent' });
    expect(followup).not.toHaveBeenCalled();

    steer.mockRejectedValue(new Error('connection lost'));
    expect(await injectIntoChat(7, 'note', undefined, { mode: 'auto' })).toMatchObject({ success: false, delivery: 'unknown' });
    expect(followup).not.toHaveBeenCalled();
  });

  it('does not inject into a replacement request and treats provider errors as uncertain', async () => {
    const injectMessage = vi.fn().mockRejectedValue(new Error('connection lost'));
    stateMock.getSession.mockReturnValue({
      activeRequest: { requestId: 'new-request' }, runtime: { steer: injectMessage },
    });
    const { injectIntoChat } = await loadSessionOps();
    await expect(injectIntoChat(7, 'result', undefined, { expectedRequestId: 'old-request' }))
      .resolves.toMatchObject({ delivery: 'not-sent' });
    expect(injectMessage).not.toHaveBeenCalled();
    await expect(injectIntoChat(7, 'result')).resolves.toMatchObject({ delivery: 'unknown' });
    expect(persistenceMock.persistInjectedUserMessage).not.toHaveBeenCalled();
  });

  it('steers a turn the agent started on its own, which has no active request', async () => {
    const injectMessage = vi.fn().mockResolvedValue(undefined);
    stateMock.getSession.mockReturnValue({ activeRequest: null, runtime: { steer: injectMessage } });
    liveTurnMock.getLiveTurn.mockReturnValue({ isDone: false });
    helpersMock.createSteerUserMessage.mockReturnValue({ id: 'steer-1', role: 'user', parts: [] });
    persistenceMock.persistInjectedUserMessage.mockReturnValue({ success: true });
    const { injectIntoChat } = await loadSessionOps();

    await expect(injectIntoChat(7, 'also check logs')).resolves.toMatchObject({ success: true, delivery: 'accepted' });
    expect(injectMessage).toHaveBeenCalledWith('also check logs', { id: expect.any(String) });
    // A caller pinned to a specific request still never lands in an agent-started turn.
    await expect(injectIntoChat(7, 'x', undefined, { expectedRequestId: 'request-1' }))
      .resolves.toMatchObject({ delivery: 'not-sent', error: 'Active request changed' });
  });

  it('does not steer once the agent-started turn has finished', async () => {
    const injectMessage = vi.fn();
    stateMock.getSession.mockReturnValue({ activeRequest: null, runtime: { steer: injectMessage } });
    liveTurnMock.getLiveTurn.mockReturnValue({ isDone: true });
    const { injectIntoChat } = await loadSessionOps();

    await expect(injectIntoChat(7, 'late')).resolves.toMatchObject({
      delivery: 'not-sent', error: 'Session is not currently generating',
    });
    expect(injectMessage).not.toHaveBeenCalled();
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
