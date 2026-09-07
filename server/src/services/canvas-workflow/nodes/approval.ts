import type { CanvasApprovalNodeData, CanvasNode } from '../../../types/canvas-workflow.js'
import { notify } from '../../notification-service.js'
import { registerApproval, unregisterApproval, type ApprovalDecision } from '../approvals.js'
import type { NodeExecutorDefinition } from '../types.js'

/**
 * Pause until a person approves in the app. The request goes to the inbox
 * (severity "action", so it pushes to the phone) and the node sits in
 * `waiting`; the decide route settles it. Approve passes the node's inputs
 * through as its output, reject fails the node.
 */
export const approvalNode: NodeExecutorDefinition = {
  timeoutMs: (node: CanvasNode) => (node.data as CanvasApprovalNodeData).timeoutMs,

  execute: async (ctx) => {
    const data = ctx.node.data as CanvasApprovalNodeData
    const message = ctx.render(data.message ?? '').trim() || `Workflow is waiting for your approval at "${ctx.node.name}".`
    const workflowName = ctx.options.workflow?.name ?? `workflow ${ctx.workflowId}`
    const sourceKey = `canvas-approval:${ctx.runId}:${ctx.nodeId}`

    ctx.storage.updateCanvasNodeResult(ctx.runId, ctx.nodeId, { status: 'waiting', output: message })
    notify(ctx.storage, {
      kind: 'workflow_approval',
      severity: 'action',
      sourceKey,
      title: `Approval needed: ${workflowName}`,
      body: message,
      workspaceId: ctx.workspaceId ?? null,
    })

    const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
      registerApproval({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        workflowId: ctx.workflowId,
        message,
        createdAt: Date.now(),
        settle: resolve,
      })
      ctx.signal.addEventListener('abort', () => {
        unregisterApproval(ctx.runId, ctx.nodeId)
        reject(new Error('approval failed: timed out waiting for a decision'))
      }, { once: true })
    }).finally(() => {
      ctx.storage.notificationMarkReadBySource(sourceKey)
    })

    if (!decision.approved) {
      throw new Error(`approval failed: rejected by user${decision.comment ? ` — ${decision.comment}` : ''}`)
    }
    return JSON.stringify({ approved: true, comment: decision.comment ?? '', decidedAt: Date.now() })
  },
}
