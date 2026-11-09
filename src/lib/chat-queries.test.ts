import { describe, expect, it } from 'vitest';
import { turnDiffsEnabled } from './chat-queries';

describe('turn diffs enabled', () => {
  it('waits for both local completion and a confirmed idle node', () => {
    expect(turnDiffsEnabled(1, '/repo', 'ready', false)).toBe(true);
    expect(turnDiffsEnabled(1, '/repo', 'error', false)).toBe(true);
    for (const presence of [null, true, false]) {
      expect(turnDiffsEnabled(1, '/repo', 'streaming', presence)).toBe(false);
      expect(turnDiffsEnabled(1, '/repo', 'submitted', presence)).toBe(false);
    }
    expect(turnDiffsEnabled(1, '/repo', 'ready', null)).toBe(false);
    expect(turnDiffsEnabled(1, '/repo', 'ready', true)).toBe(false);
    expect(turnDiffsEnabled(undefined, '/repo', 'ready', false)).toBe(false);
    expect(turnDiffsEnabled(1, null, 'ready', false)).toBe(false);
    expect(turnDiffsEnabled(1, '', 'ready', false)).toBe(false);
  });
});
