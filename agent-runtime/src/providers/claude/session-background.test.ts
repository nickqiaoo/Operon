import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createRuntimeContext } from '../../context.js';

const ctx = createRuntimeContext({ resolveBinary: () => '/mock/claude' });
import type { RuntimeBackgroundEvent, RuntimeBackgroundTask, RuntimeStreamPart } from '../../types.js';
import { ClaudeRuntimeSession } from './session.js';

const sdkMock = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: sdkMock.query };
});

const AGENT_CALL = 'toolu_agent';

const result = (sessionId = 'session-1') =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'done',
    session_id: sessionId,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
  }) as unknown as SDKMessage;

const assistant = (content: unknown[], parent: string | null = null) =>
  ({
    type: 'assistant',
    parent_tool_use_id: parent,
    session_id: 'session-1',
    message: { role: 'assistant', content },
  }) as unknown as SDKMessage;

const system = (fields: Record<string, unknown>) =>
  ({ type: 'system', session_id: 'session-1', uuid: 'u', ...fields }) as unknown as SDKMessage;

/**
 * The CLI's output for "launch a background agent": the launch turn ends at once,
 * then — with no turn open — the sub-agent works, finishes, and the main agent
 * replies to that on its own. Recorded shape from a real run (Claude Code 2.1.276).
 */
function mockBackgroundAgentRun(): { release: () => void } {
  let release!: () => void;
  const afterLaunch = new Promise<void>((resolve) => {
    release = resolve;
  });
  sdkMock.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => ({
    async *[Symbol.asyncIterator]() {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield assistant([
        { type: 'tool_use', id: AGENT_CALL, name: 'Agent', input: { description: 'Check docs', run_in_background: true } },
      ]);
      yield system({
        subtype: 'task_started',
        task_id: 'agent-1',
        tool_use_id: AGENT_CALL,
        description: 'Check docs',
        task_type: 'local_agent',
        is_backgrounded: true,
      });
      yield assistant([{ type: 'text', text: 'launched' }]);
      yield result();

      await afterLaunch;
      yield assistant([{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'ls' } }], AGENT_CALL);
      yield system({
        subtype: 'task_progress',
        task_id: 'agent-1',
        tool_use_id: AGENT_CALL,
        description: 'Check docs',
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
        last_tool_name: 'Bash',
      });
      yield system({
        subtype: 'task_notification',
        task_id: 'agent-1',
        tool_use_id: AGENT_CALL,
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'Docs are current',
      });
      yield assistant([{ type: 'text', text: 'The agent reports the docs are current.' }]);
      yield result();
      await iterator.next();
    },
    initializationResult: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    interrupt: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Query);
  return { release };
}

async function collect(parts: AsyncIterable<RuntimeStreamPart>): Promise<RuntimeStreamPart[]> {
  const out: RuntimeStreamPart[] = [];
  for await (const part of parts) out.push(part);
  return out;
}

function text(parts: RuntimeStreamPart[]): string {
  return parts.map((part) => (part.type === 'text-delta' ? part.text : '')).join('');
}

describe('ClaudeRuntimeSession between turns', () => {

  afterEach(() => {
    sdkMock.query.mockReset();
  });

  it('reports background agents and hands over the reply the agent starts itself', async () => {
    const { release } = mockBackgroundAgentRun();
    const session = new ClaudeRuntimeSession({
      cwd: '/tmp',
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      modeId: 'default',
    }, ctx);

    const taskSnapshots: RuntimeBackgroundTask[][] = [];
    let agentTurn: Promise<RuntimeStreamPart[]> | undefined;
    session.onBackground((event: RuntimeBackgroundEvent) => {
      if (event.type === 'tasks') taskSnapshots.push(event.tasks);
      else agentTurn = collect(event.parts);
    });

    const launch = await collect(session.stream({ requestId: 'r1', messages: [{ role: 'user', content: 'go' }] }));
    expect(text(launch)).toBe('launched');
    expect(taskSnapshots.at(-1)).toEqual([
      expect.objectContaining({ taskId: 'agent-1', toolUseId: AGENT_CALL, status: 'running' }),
    ]);

    release();
    await vi.waitFor(() => expect(agentTurn).toBeDefined());
    const reply = await agentTurn!;

    expect(text(reply)).toBe('The agent reports the docs are current.');
    expect(reply.some((part) => part.type === 'finish')).toBe(true);
    // The sub-agent's own step has no card in this reply to hang off.
    expect(reply.some((part) => 'toolName' in part && part.toolName === 'Bash')).toBe(false);
    expect(taskSnapshots.at(-1)).toEqual([
      expect.objectContaining({ status: 'completed', toolUses: 1, lastToolName: 'Bash', summary: 'Docs are current' }),
    ]);

    await session.dispose();
  });
});
