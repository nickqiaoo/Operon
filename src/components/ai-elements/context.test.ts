import { describe, expect, it } from 'vitest';
import { contextBreakdown } from './context';
import type { DetailedContextUsage, DetailedContextUsageCategory } from '@/types/context-usage';

const usage = (
  categories: DetailedContextUsageCategory[],
  overrides: Partial<DetailedContextUsage> = {}
): DetailedContextUsage => ({
  categories,
  totalTokens: categories
    .filter((c) => c.kind !== 'free' && c.kind !== 'deferred')
    .reduce((sum, c) => sum + c.tokens, 0),
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 7,
  model: 'claude-opus-5',
  memoryFiles: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
  ...overrides,
});

describe('contextBreakdown', () => {
  it('assigns the chart slots to content rows in order, never reusing one', () => {
    const { slices } = contextBreakdown(
      usage([
        { name: 'Messages', tokens: 32_700, color: 'blue', kind: 'used' },
        { name: 'System tools', tokens: 25_200, color: 'orange', kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'grey', kind: 'buffer' },
        { name: 'Free space', tokens: 892_200, color: 'grey', kind: 'free' },
      ])
    );

    expect(slices.map((s) => s.swatch)).toEqual([
      'var(--color-chart-1)',
      'var(--color-chart-2)',
      'var(--color-chart-neutral)',
      'var(--color-chart-empty)',
    ]);
  });

  it('paints a seventh content row neutral rather than cycling back to slot 1', () => {
    const { slices } = contextBreakdown(
      usage(
        Array.from({ length: 7 }, (_, i) => ({
          name: `Row ${i}`,
          tokens: 1000,
          color: '',
          kind: 'used' as const,
        }))
      )
    );

    const swatches = slices.slice(0, 7).map((s) => s.swatch);
    expect(swatches[6]).toBe('var(--color-chart-neutral)');
    expect(new Set(swatches.slice(0, 6)).size).toBe(6);
  });

  it('measures shares against the raw window, not the post-reserve one', () => {
    // The two differ exactly when a compaction reserve is carved out; the header's
    // percentage is computed against the raw window, so the rows must be too.
    const { windowTokens, slices } = contextBreakdown(
      usage([{ name: 'Messages', tokens: 100_000, color: '', kind: 'used' }], {
        maxTokens: 500_000,
        rawMaxTokens: 1_000_000,
      })
    );

    expect(windowTokens).toBe(1_000_000);
    expect(slices[0].share).toBeCloseTo(0.1);
  });

  it('sinks out-of-window rows to the bottom, keeping content colours in one run', () => {
    // Claude's SDK lists deferred rows wherever it likes — here, in the middle.
    const { slices } = contextBreakdown(
      usage([
        { name: 'System prompt', tokens: 11_400, color: '', kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 115_000, color: '', kind: 'deferred' },
        { name: 'Messages', tokens: 17_700, color: '', kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, color: '', kind: 'buffer' },
        { name: 'Free space', tokens: 921_200, color: '', kind: 'free' },
      ])
    );

    expect(slices.map((s) => s.name)).toEqual([
      'System prompt',
      'Messages',
      'Autocompact buffer',
      'Free space',
      'MCP tools (deferred)',
    ]);
    // ...and the two content rows still take slots 1 and 2, in the provider's order.
    expect(slices.slice(0, 2).map((s) => s.swatch)).toEqual([
      'var(--color-chart-1)',
      'var(--color-chart-2)',
    ]);
  });

  it('gives deferred rows no share — they sit outside the window', () => {
    const { slices } = contextBreakdown(
      usage([
        { name: 'Messages', tokens: 10_000, color: '', kind: 'used' },
        { name: 'System tools (deferred)', tokens: 26_500, color: '', kind: 'deferred' },
      ])
    );

    expect(slices.find((s) => s.kind === 'deferred')?.share).toBeNull();
  });

  it('infers kind from isDeferred and the name when a provider omits it', () => {
    const { slices } = contextBreakdown(
      usage([
        { name: 'Messages', tokens: 10_000, color: '' },
        { name: 'Compact buffer', tokens: 5_000, color: '' },
        { name: 'Free space', tokens: 985_000, color: '' },
        { name: 'MCP tools (deferred)', tokens: 26_500, color: '', isDeferred: true },
      ])
    );

    expect(slices.map((s) => s.kind)).toEqual(['used', 'buffer', 'free', 'deferred']);
  });

  it('synthesises the free row when a provider reports none, net of the reserve', () => {
    const { slices } = contextBreakdown(
      usage([
        { name: 'Messages', tokens: 100_000, color: '', kind: 'used' },
        { name: 'Autocompact buffer', tokens: 200_000, color: '', kind: 'buffer' },
      ])
    );

    const free = slices.find((s) => s.kind === 'free');
    expect(free?.tokens).toBe(700_000);
  });
});
