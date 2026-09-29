import { describe, it, expect } from 'vitest';
import { isCompactEligible } from './isCompactEligible';
import { isScheduleTaskResult } from '../ScheduleTaskRenderer';
import type { ToolPartLike } from '../toolName';

const task = { id: 9, name: 'PR digest', enabled: true, when: '09:00, Mon,Tue,Wed,Thu,Fri', provider_id: 'claude-code' };
const call = (toolName: string, output: unknown): ToolPartLike =>
  ({ type: 'dynamic-tool', toolName, state: 'output-available', output }) as ToolPartLike;
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

describe('schedule tool card', () => {
  it('recognises a created or updated task under every client prefix', () => {
    for (const name of ['mcp__schedule__schedule_create', 'schedule_schedule_create', 'mcp__schedule__schedule_update']) {
      const part = call(name, text(JSON.stringify({ task })));
      expect(isScheduleTaskResult(part)).toBe(true);
      expect(isCompactEligible(part)).toBe(false);
    }
  });

  it('stays compact for failures, reads and other tools', () => {
    const cases = [
      call('mcp__schedule__schedule_create', text('Start time must be between 00:00 and 23:59')),
      call('mcp__schedule__schedule_create', undefined),
      call('mcp__schedule__schedule_list', text(JSON.stringify({ tasks: [task] }))),
      call('mcp__other__create', text(JSON.stringify({ task }))),
    ];
    for (const part of cases) {
      expect(isScheduleTaskResult(part)).toBe(false);
      expect(isCompactEligible(part)).toBe(true);
    }
  });
});
