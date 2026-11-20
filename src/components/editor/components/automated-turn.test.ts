import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { isAutomatedUserMessage } from './automated-turn';

const user = (text: string, metadata?: Record<string, unknown>): UIMessage => ({
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text }],
  ...(metadata ? { metadata } : {}),
});

describe('isAutomatedUserMessage', () => {
  it('flags a background task settling', () => {
    const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>\n</task-notification>';
    expect(isAutomatedUserMessage(user(text))).toBe(true);
  });

  it('flags a Monitor event', () => {
    const text = '<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "ci"</summary>\n<event>Vitest (App): failure</event>\n</task-notification>';
    expect(isAutomatedUserMessage(user(text))).toBe(true);
  });

  it('leaves what the user typed alone', () => {
    expect(isAutomatedUserMessage(user('ship it'))).toBe(false);
  });

  it('leaves a steer (a follow-up the user typed mid-turn) alone', () => {
    const text = '<task-notification>\n<summary>Monitor event: "ci"</summary>\n</task-notification>';
    expect(isAutomatedUserMessage(user(text, { steer: true }))).toBe(false);
  });

  it('ignores assistant messages', () => {
    expect(isAutomatedUserMessage({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '<task-notification></task-notification>' }] })).toBe(false);
  });
});

describe('automatedTrigger', () => {
  it('gives a teammate message no rail', async () => {
    const { automatedTrigger } = await import('./automated-turn');
    expect(automatedTrigger(user('PONG-OK', { peer: { from: 'ping' } }))).toBe('silent');
  });

  it('hangs the rail off a background notice', async () => {
    const { automatedTrigger } = await import('./automated-turn');
    const text = '<task-notification>\n<summary>Monitor event: "ci"</summary>\n<event>ok</event>\n</task-notification>';
    expect(automatedTrigger(user(text))).toBe('notice');
  });
});
