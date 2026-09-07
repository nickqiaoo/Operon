import type { CanvasApprovalNodeData } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField, VARIABLES_HINT } from "./fields"

export function ApprovalPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasApprovalNodeData
  onUpdate: (updates: Partial<CanvasApprovalNodeData>) => void
}) {
  return (
    <div className="space-y-4">
      <Field label="Request" hint={`Shown in the inbox and on the results panel, where you approve or reject. ${VARIABLES_HINT}`}>
        <TextAreaField
          value={nodeData.message || ""}
          onChange={(message) => onUpdate({ message })}
          placeholder={"Deploy {{ version }} to production?\n\nChanges:\n{{ summary }}"}
          minHeight="min-h-[120px]"
        />
      </Field>
      <Field label="Timeout (ms)" hint="Optional. Without it the run waits until the app restarts.">
        <NumberField value={nodeData.timeoutMs} onChange={(timeoutMs) => onUpdate({ timeoutMs })} placeholder="no timeout" />
      </Field>
      <p className="text-[10px] text-muted-foreground/50">
        Approve passes the run on; reject fails this node and skips everything after it. A restart while waiting loses the run.
      </p>
    </div>
  )
}
