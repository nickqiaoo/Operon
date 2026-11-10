import { describe, expect, it } from 'vitest';
import { resolveReviewTurnUid } from './review-turn-store';

describe('resolveReviewTurnUid', () => {
  it('moves to a newer turn when the target follows the latest one', () => {
    expect(resolveReviewTurnUid({ messageUid: 'turn-1', followLatest: true }, 'turn-2')).toBe('turn-2');
  });

  it('keeps showing the clicked turn until the turn list is known', () => {
    expect(resolveReviewTurnUid({ messageUid: 'turn-1', followLatest: true }, undefined)).toBe('turn-1');
  });

  it('stays on an older turn the user opened explicitly', () => {
    expect(resolveReviewTurnUid({ messageUid: 'turn-1', followLatest: false }, 'turn-3')).toBe('turn-1');
  });

  it('returns null without a target', () => {
    expect(resolveReviewTurnUid(undefined, 'turn-3')).toBeNull();
  });
});
