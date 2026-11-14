import { describe, expect, it } from 'vitest';
import { countContentLines, exceedsDiffLimits, prepareDiff } from './prepare-diff';

describe('tool diff preparation', () => {
  it.each([['', 0], ['one', 1], ['one\n', 1], ['one\ntwo', 2], ['\n\n', 2]])(
    'counts additions without inventing a trailing blank line: %j', (text, count) => {
      expect(countContentLines(text)).toBe(count);
    },
  );

  it('returns exact replacement statistics and preserves context', () => {
    const result = prepareDiff({ filePath: 'test.ts', oldContent: 'keep\nold\nend', newContent: 'keep\nnew\nextra\nend' });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.stats).toEqual({ additions: 2, deletions: 1 });
    expect(result.fileDiff.additionLines.join('')).toContain('keep');
  });

  it('handles creation, deletion, and unchanged text', () => {
    for (const [oldContent, newContent, stats] of [
      ['', 'one\ntwo', { additions: 2, deletions: 0 }],
      ['one\ntwo', '', { additions: 0, deletions: 2 }],
      ['same', 'same', { additions: 0, deletions: 0 }],
    ] as const) {
      const result = prepareDiff({ filePath: 'test.md', oldContent, newContent });
      expect(result.status).toBe('ready');
      if (result.status === 'ready') expect(result.stats).toEqual(stats);
    }
  });

  it('limits giant files and long lines before comparison', () => {
    for (const text of ['x'.repeat(2 * 1024 * 1024 + 1), '\n'.repeat(20_000), 'x'.repeat(20_001)]) {
      expect(exceedsDiffLimits(text)).toBe(true);
      expect(prepareDiff({ filePath: 'test.txt', oldContent: '', newContent: text })).toEqual({ status: 'limited' });
    }
  });

  it('allows a ten-thousand-line file for virtual rendering', () => {
    const result = prepareDiff({ filePath: 'large.md', oldContent: '', newContent: 'line\n'.repeat(10_000) });
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.stats.additions).toBe(10_000);
  });
});
