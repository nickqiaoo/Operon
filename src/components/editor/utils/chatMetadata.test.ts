import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { extractContextCompaction, extractPeerMessage, extractRetry } from './chatMetadata';

const messageWithMetadata = (metadata: Record<string, unknown>): UIMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  parts: [],
  metadata,
});

describe('extractRetry', () => {
  it('reads retry state and accepts explicit clearing', () => {
    const retry = { attempt: 2, maxAttempts: 10, retryAt: 12345, reason: '429 Too Many Requests' };
    expect(extractRetry(messageWithMetadata({ retry }))).toEqual(retry);
    expect(extractRetry(messageWithMetadata({ retry: null }))).toBeNull();
    expect(extractRetry({ ...messageWithMetadata({ retry }), role: 'user' })).toBeNull();
  });

  it('ignores missing and malformed retry metadata', () => {
    expect(extractRetry(undefined)).toBeNull();
    expect(extractRetry(messageWithMetadata({}))).toBeNull();
    expect(extractRetry(messageWithMetadata({ retry: { attempt: '1', maxAttempts: 10, retryAt: 100 } }))).toBeNull();
    expect(extractRetry(messageWithMetadata({ retry: { attempt: 1, maxAttempts: 10, retryAt: NaN } }))).toBeNull();
  });
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

describe('extractPeerMessage', () => {
  const userMessage = (metadata?: Record<string, unknown>): UIMessage => ({
    id: 'user-1',
    role: 'user',
    parts: [],
    ...(metadata ? { metadata } : {}),
  });

  it('reads the sender the observer stamped on a peer delivery', () => {
    expect(extractPeerMessage(userMessage({ peer: { from: 'dba' } }))).toEqual({ from: 'dba' });
  });

  it('ignores messages the user actually typed', () => {
    expect(extractPeerMessage(userMessage())).toBeNull();
    expect(extractPeerMessage(userMessage({ peer: { from: '  ' } }))).toBeNull();
    expect(extractPeerMessage(userMessage({ peer: {} }))).toBeNull();
  });

  // The stamp only ever goes on the inbound user-role message; an assistant reply that
  // happened to carry one would be the model's own turn, not a teammate talking.
  it('ignores assistant messages', () => {
    expect(extractPeerMessage(messageWithMetadata({ peer: { from: 'dba' } }))).toBeNull();
  });
});
