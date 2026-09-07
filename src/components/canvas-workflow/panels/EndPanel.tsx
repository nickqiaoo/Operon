import type { CanvasEndNodeData } from "@/types/canvas-workflow"
import { VARIABLES_HINT, labelClass } from "./fields"
import { KeyValueList } from "./KeyValueList"

export function EndPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasEndNodeData
  onUpdate: (updates: Partial<CanvasEndNodeData>) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelClass}>Outputs</label>
      <KeyValueList
        entries={nodeData.outputs ?? []}
        onChange={(outputs) => onUpdate({ outputs })}
        keyPlaceholder="key"
        valuePlaceholder="{{ summary }}"
        addLabel="Add output"
      />
      <p className="text-[10px] text-muted-foreground/50">
        These become the run's outputs, which a parent workflow receives when it calls this one. {VARIABLES_HINT}
      </p>
    </div>
  )
}
