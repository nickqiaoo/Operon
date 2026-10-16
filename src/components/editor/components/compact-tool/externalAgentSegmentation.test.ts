import { describe, it, expect } from 'vitest';
import { isCompactEligible } from './isCompactEligible';
import { segmentMessageParts } from './segmentParts';
import type { ToolPartLike } from '../toolName';
import type { UIMessage } from 'ai';

const accepted = {
  content: [{ type: 'text', text: JSON.stringify({ agent_id: 'ext-20', chat_id: 20, agent_type: 'opencode', status: 'running' }) }],
};
const run = (toolName: string, output: unknown): ToolPartLike =>
  ({
    type: 'dynamic-tool',
    toolName,
    state: output === undefined ? 'input-available' : 'output-available',
    input: { server: 'external_agent', tool: 'external_agent_run', arguments: { agent_type: 'opencode' } },
    output: output === undefined ? undefined : { server: 'external_agent', tool: 'external_agent_run', status: 'completed', result: accepted },
  }) as ToolPartLike;
const exec = { type: 'dynamic-tool', toolName: 'exec', state: 'output-available', input: { command: 'ls' }, output: 'ok' };

describe('external agent card', () => {
  it('pulls a returned run or send out of the tool group', () => {
    for (const name of ['mcp__external_agent__external_agent_run', 'external_agent_external_agent_run', 'mcp__external_agent__external_agent_send']) {
      expect(isCompactEligible(run(name, accepted))).toBe(false);
    }
  });

  it('keeps a call that has not returned compact, so nothing vanishes', () => {
    expect(isCompactEligible(run('mcp__external_agent__external_agent_run', undefined))).toBe(true);
    expect(isCompactEligible(run('mcp__external_agent__external_agent_list_models', accepted))).toBe(true);
  });

  it('stays its own segment after the parent keeps talking', () => {
    const parts = [
      exec,
      run('mcp__external_agent__external_agent_run', accepted),
      { type: 'text', text: 'OpenCode is planning now.' },
    ] as unknown as UIMessage['parts'];
    const segments = segmentMessageParts(parts, new Set());
    expect(segments).toEqual([
      { type: 'tool-group', partIndices: [0] },
      { type: 'single', partIndex: 1 },
      { type: 'single', partIndex: 2 },
    ]);
  });
});
