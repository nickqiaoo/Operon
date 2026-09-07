import type { CanvasTemplateNodeData } from "@/types/canvas-workflow"
import { Field, TextAreaField, VARIABLES_HINT } from "./fields"

export function TemplatePanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasTemplateNodeData
  onUpdate: (updates: Partial<CanvasTemplateNodeData>) => void
}) {
  return (
    <Field label="Template" hint={`${VARIABLES_HINT} Filters: | tojson, | lines. Skipped nodes are undefined: {{ a or b }}.`}>
      <TextAreaField
        value={nodeData.template || ""}
        onChange={(template) => onUpdate({ template })}
        placeholder={"Summary:\n{{ review }}\n\nTests:\n{{ tests }}"}
        minHeight="min-h-[160px]"
      />
    </Field>
  )
}
