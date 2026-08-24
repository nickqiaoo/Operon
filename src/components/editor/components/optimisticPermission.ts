export type OptimisticPermissionOutcome = 'allow' | 'deny';

export interface OptimisticPermissionDecision {
  approvalId: string;
  outcome: OptimisticPermissionOutcome;
}

/**
 * One outer tool call can raise several host approvals in sequence. An
 * optimistic result belongs only to the approvalId the user just answered, and
 * must not leak into the next approval.
 */
export function getOptimisticPermissionOutcome(
  approvalId: string | undefined,
  decision: OptimisticPermissionDecision | null,
): OptimisticPermissionOutcome | null {
  return approvalId && decision?.approvalId === approvalId ? decision.outcome : null;
}
