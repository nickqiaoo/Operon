import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type {
  McpServerStatus,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { setRuntimeHost } from '../../host.js';
import { ClaudeRuntimeSession } from './session.js';
import { SIDE_CHAT_BOUNDARY_PROMPT } from '../../side-chat-prompt.js';

const sdkMock = vi.hoisted(() => ({
  query: vi.fn(),
  deleteSession: vi.fn(async () => {}),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: sdkMock.query,
    deleteSession: sdkMock.deleteSession,
  };
});

const resultMessage = {
  type: 'result',
  subtype: 'success',
  duration_ms: 10,
  duration_api_ms: 8,
  is_error: false,
  num_turns: 1,
  result: 'done',
  session_id: 'session-1',
  total_cost_usd: 0,
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
  },
  modelUsage: {},
} as unknown as SDKMessage;

function mockStreamingQuery(options?: {
  mcpServerStatus?: () => Promise<McpServerStatus[]>;
  onUserMessage?: (message: SDKUserMessage) => void;
}) {
  const initializationResult = vi.fn().mockResolvedValue({});
  const mcpServerStatus =
    options?.mcpServerStatus ?? vi.fn().mockResolvedValue([]);
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const reconnectMcpServer = vi.fn().mockResolvedValue(undefined);
  const toggleMcpServer = vi.fn().mockResolvedValue(undefined);
  const usageLimits = vi.fn();
  const contextUsage = vi.fn();

  sdkMock.query.mockImplementation(
    ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) => {
      if (typeof prompt === 'string') {
        throw new Error('Expected a streaming prompt');
      }

      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) {
            options?.onUserMessage?.(message);
            yield resultMessage;
          }
        },
        initializationResult,
        mcpServerStatus,
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageLimits,
        getContextUsage: contextUsage,
        interrupt,
        reconnectMcpServer,
        toggleMcpServer,
      } as unknown as Query;
    },
  );

  return {
    initializationResult,
    mcpServerStatus,
    usageLimits,
    contextUsage,
    interrupt,
    reconnectMcpServer,
    toggleMcpServer,
  };
}

describe('ClaudeRuntimeSession stream completion', () => {
  beforeEach(() => {
    setRuntimeHost({
      resolveCliPath: () => '/mock/claude',
      getShellEnv: () => ({}),
      getUserEnv: () => ({}),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    sdkMock.query.mockReset();
  });

  it('finishes the message stream without invoking slow usage control requests', async () => {
    const { usageLimits, contextUsage } = mockStreamingQuery();

    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const parts = [];

    for await (const part of session.stream({
      requestId: 'request-1',
      messages,
    })) {
      parts.push(part);
    }

    expect(parts.some((part) => part.type === 'finish')).toBe(true);
    expect(usageLimits).not.toHaveBeenCalled();
    expect(contextUsage).not.toHaveBeenCalled();

    await session.dispose();
  });

  it('waits for pending MCP servers before delivering the first user message', async () => {
    const receivedMessages: SDKUserMessage[] = [];
    const mcpServerStatus = vi
      .fn<() => Promise<McpServerStatus[]>>()
      .mockResolvedValueOnce([{ name: 'electron-devtools', status: 'pending' }])
      .mockResolvedValueOnce([{ name: 'electron-devtools', status: 'connected' }]);
    mockStreamingQuery({
      mcpServerStatus,
      onUserMessage: (message) => receivedMessages.push(message),
    });

    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const streamPromise = (async () => {
      const parts = [];
      for await (const part of session.stream({
        requestId: 'request-1',
        messages,
      })) {
        parts.push(part);
      }
      return parts;
    })();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(mcpServerStatus).toHaveBeenCalledTimes(1);
    expect(receivedMessages).toHaveLength(0);

    const parts = await streamPromise;
    expect(mcpServerStatus).toHaveBeenCalledTimes(2);
    expect(receivedMessages).toHaveLength(1);
    expect(parts.some((part) => part.type === 'finish')).toBe(true);

    await session.dispose();
  });

  it('proceeds after the MCP readiness timeout instead of hanging the turn', async () => {
    vi.useFakeTimers();
    const receivedMessages: SDKUserMessage[] = [];
    const mcpServerStatus = vi
      .fn<() => Promise<McpServerStatus[]>>()
      .mockResolvedValue([{ name: 'electron-devtools', status: 'pending' }]);
    mockStreamingQuery({
      mcpServerStatus,
      onUserMessage: (message) => receivedMessages.push(message),
    });

    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const streamPromise = (async () => {
      const parts = [];
      for await (const part of session.stream({
        requestId: 'request-1',
        messages,
      })) {
        parts.push(part);
      }
      return parts;
    })();

    await vi.advanceTimersByTimeAsync(15_000);
    const parts = await streamPromise;

    expect(receivedMessages).toHaveLength(1);
    expect(parts.some((part) => part.type === 'finish')).toBe(true);

    await session.dispose();
  });

  it('exposes MCP status, reconnect, and toggle through session control', async () => {
    const mcpServerStatus = vi
      .fn<() => Promise<McpServerStatus[]>>()
      .mockResolvedValue([
        {
          name: 'electron-devtools',
          status: 'connected',
          config: { type: 'stdio', command: 'electron-devtools-mcp' },
          tools: [{ name: 'inspect' }, { name: 'screenshot' }],
        },
      ]);
    const { reconnectMcpServer, toggleMcpServer } = mockStreamingQuery({ mcpServerStatus });
    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];

    for await (const _part of session.stream({
      requestId: 'request-1',
      messages,
    })) {
      // Start the warm query before exercising session controls.
    }

    await expect(session.agentControl('mcp.list', undefined)).resolves.toEqual({
      servers: [
        {
          name: 'electron-devtools',
          status: 'connected',
          transport: 'stdio',
          toolCount: 2,
        },
      ],
    });
    await session.agentControl('mcp.reconnect', { name: 'electron-devtools' });
    await Promise.resolve();
    expect(mcpServerStatus).toHaveBeenCalledTimes(3);

    await session.agentControl('mcp.toggle', {
      name: 'electron-devtools',
      enabled: false,
    });
    expect(mcpServerStatus).toHaveBeenCalledTimes(3);
    await session.agentControl('mcp.toggle', {
      name: 'electron-devtools',
      enabled: true,
    });
    await Promise.resolve();

    expect(reconnectMcpServer).toHaveBeenCalledWith('electron-devtools');
    expect(toggleMcpServer).toHaveBeenNthCalledWith(1, 'electron-devtools', false);
    expect(toggleMcpServer).toHaveBeenNthCalledWith(2, 'electron-devtools', true);
    expect(mcpServerStatus).toHaveBeenCalledTimes(4);

    await session.dispose();
  });

  it('waits again before the next message after reconnecting an MCP server', async () => {
    let reconnecting = false;
    let reconnectStatusChecks = 0;
    const receivedMessages: SDKUserMessage[] = [];
    const mcpServerStatus = vi.fn<() => Promise<McpServerStatus[]>>(async () => {
      if (!reconnecting) {
        return [{ name: 'electron-devtools', status: 'connected' }];
      }
      reconnectStatusChecks += 1;
      return [{
        name: 'electron-devtools',
        status: reconnectStatusChecks === 1 ? 'pending' : 'connected',
      }];
    });
    const { reconnectMcpServer } = mockStreamingQuery({
      mcpServerStatus,
      onUserMessage: (message) => receivedMessages.push(message),
    });
    reconnectMcpServer.mockImplementation(async () => {
      reconnecting = true;
    });

    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];

    for await (const _part of session.stream({
      requestId: 'request-1',
      messages,
    })) {
      // Complete the first turn with the initially connected server.
    }
    expect(receivedMessages).toHaveLength(1);

    await session.agentControl('mcp.reconnect', { name: 'electron-devtools' });
    const secondStream = (async () => {
      for await (const _part of session.stream({
        requestId: 'request-2',
        messages,
      })) {
        // The message should not reach the input queue while MCP is pending.
      }
    })();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(receivedMessages).toHaveLength(1);

    await secondStream;
    expect(reconnectStatusChecks).toBe(2);
    expect(receivedMessages).toHaveLength(2);

    await session.dispose();
  });
});

describe('ClaudeRuntimeSession side chat', () => {
  beforeEach(() => {
    setRuntimeHost({
      resolveCliPath: () => '/mock/claude',
      getShellEnv: () => ({}),
      getUserEnv: () => ({}),
    });
  });

  afterEach(() => {
    sdkMock.query.mockReset();
    sdkMock.deleteSession.mockClear();
  });

  const forkParams = {
    cwd: '/tmp',
    providerId: 'claude-code',
    modelId: 'claude-sonnet-4-5',
    modeId: 'default',
    forkFrom: { sessionId: 'parent-session', ephemeral: true },
  };
  const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];

  async function runTurn(session: ClaudeRuntimeSession, requestId: string) {
    for await (const _part of session.stream({ requestId, messages })) {
      // Drain the turn.
    }
  }

  it('branches off the parent once and opens with the boundary marker', async () => {
    const receivedMessages: SDKUserMessage[] = [];
    mockStreamingQuery({ onUserMessage: (message) => receivedMessages.push(message) });

    const session = new ClaudeRuntimeSession(forkParams);
    await runTurn(session, 'request-1');

    // The fork resumes the PARENT — the branch has no id of its own yet.
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    const firstOptions = sdkMock.query.mock.calls[0][0].options;
    expect(firstOptions.resume).toBe('parent-session');
    expect(firstOptions.forkSession).toBe(true);

    // The parent's transcript comes with the fork, so the branch's first message
    // has to say where the inherited history stops.
    const firstContent = receivedMessages[0].message.content;
    expect(Array.isArray(firstContent)).toBe(true);
    const firstBlock = (firstContent as Array<{ type: string; text?: string }>)[0];
    expect(firstBlock.text).toBe(SIDE_CHAT_BOUNDARY_PROMPT);

    // Second turn rides the same warm query, so no second fork and no repeat marker.
    await runTurn(session, 'request-2');
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    const secondContent = receivedMessages[1].message.content;
    const secondBlock = (secondContent as Array<{ type: string; text?: string }>)[0];
    expect(secondBlock.text).not.toBe(SIDE_CHAT_BOUNDARY_PROMPT);

    await session.dispose();
  });

  it('resumes its own branch, not the parent, when the query is rebuilt', async () => {
    mockStreamingQuery();

    const session = new ClaudeRuntimeSession(forkParams);
    await runTurn(session, 'request-1');

    // Kill the warm query the way a dropped CLI process would.
    Object.assign(session, { messageLoopDead: true });
    await runTurn(session, 'request-2');

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const secondOptions = sdkMock.query.mock.calls[1][0].options;
    expect(secondOptions.resume).toBe('session-1');
    expect(secondOptions.forkSession).toBe(false);

    await session.dispose();
  });

  it('deletes the branch it forked when discarded, but keeps it across a rebuild', async () => {
    mockStreamingQuery();

    const session = new ClaudeRuntimeSession(forkParams);
    await runTurn(session, 'request-1');

    await session.dispose('rebuild');
    expect(sdkMock.deleteSession).not.toHaveBeenCalled();

    await session.dispose('discard');
    expect(sdkMock.deleteSession).toHaveBeenCalledWith('session-1', { dir: '/tmp' });
  });

  it('never deletes an ordinary session', async () => {
    mockStreamingQuery();

    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    });
    await runTurn(session, 'request-1');
    await session.dispose();

    expect(sdkMock.deleteSession).not.toHaveBeenCalled();
  });
});
