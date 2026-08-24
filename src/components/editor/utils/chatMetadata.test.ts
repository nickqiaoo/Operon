import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { extractContextCompaction } from './chatMetadata';

const messageWithMetadata = (metadata: Record<string, unknown>): UIMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  parts: [],
  metadata,
});

describe('extractContextCompaction', () => {
  it('reads the current Codex compaction lifecycle metadata', () => {
    expect(extractContextCompaction(messageWithMetadata({
      contextCompaction: { id: 'compact-1', status: 'in_progress' },
    }))).toEqual({ id: 'compact-1', status: 'in_progress' });

    expect(extractContextCompaction(messageWithMetadata({
      contextCompaction: { id: 'compact-1', status: 'completed' },
    }))).toEqual({ id: 'compact-1', status: 'completed' });
  });

  it('ignores malformed lifecycle metadata', () => {
    expect(extractContextCompaction(messageWithMetadata({
      contextCompaction: { id: 'compact-1', status: 'running' },
    }))).toBeNull();
  });
});
