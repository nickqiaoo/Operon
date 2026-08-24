import { describe, expect, it } from 'vitest';
import { getOptimisticPermissionOutcome } from './optimisticPermission';

describe('getOptimisticPermissionOutcome', () => {
  it('keeps the optimistic response scoped to its approval id', () => {
    const decision = { approvalId: 'approval-1', outcome: 'allow' } as const;

    expect(getOptimisticPermissionOutcome('approval-1', decision)).toBe('allow');
    expect(getOptimisticPermissionOutcome('approval-2', decision)).toBeNull();
  });
});
