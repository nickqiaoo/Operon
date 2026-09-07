/**
 * In-memory registry of approval nodes waiting on a person. A run that is
 * waiting when the process exits is lost (marked error on the next start is
 * out of scope for now); this is deliberately not persisted.
 */

export interface PendingApproval {
  runId: number
  nodeId: string
  workflowId: number
  message: string
  createdAt: number
  settle: (decision: ApprovalDecision) => void
}

export interface ApprovalDecision {
  approved: boolean
  comment?: string
}

const pending = new Map<string, PendingApproval>()

export function approvalKey(runId: number, nodeId: string): string {
  return `${runId}:${nodeId}`
}

export function registerApproval(entry: PendingApproval): void {
  pending.set(approvalKey(entry.runId, entry.nodeId), entry)
}

export function unregisterApproval(runId: number, nodeId: string): void {
  pending.delete(approvalKey(runId, nodeId))
}

export function getPendingApproval(runId: number, nodeId: string): PendingApproval | undefined {
  return pending.get(approvalKey(runId, nodeId))
}

/** Resolve a waiting node. Returns false when nothing is waiting under that key. */
export function decideApproval(runId: number, nodeId: string, decision: ApprovalDecision): boolean {
  const entry = pending.get(approvalKey(runId, nodeId))
  if (!entry) return false
  pending.delete(approvalKey(runId, nodeId))
  entry.settle(decision)
  return true
}
