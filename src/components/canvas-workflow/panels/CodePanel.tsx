import type { CanvasCodeNodeData } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField } from "./fields"

export function CodePanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasCodeNodeData
  onUpdate: (updates: Partial<CanvasCodeNodeData>) => void
}) {
  return (
    <div className="space-y-4">
      <Field
        label="JavaScript"
        hint="Function body. `inputs` holds every upstream variable by node name (JSON outputs already parsed). Return a value; objects become JSON. No require, fs or network."
      >
        <TextAreaField
          value={nodeData.code || ""}
          onChange={(code) => onUpdate({ code })}
          placeholder={"const files = inputs.changed.split('\\n').filter(Boolean)\nreturn { count: files.length, files }"}
          mono
          minHeight="min-h-[200px]"
        />
      </Field>
      <Field label="Timeout (ms)" hint="Default 10000.">
        <NumberField value={nodeData.timeoutMs} onChange={(timeoutMs) => onUpdate({ timeoutMs })} placeholder="10000" />
      </Field>
    </div>
  )
}
