import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { CanvasIterationNodeData } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField, TextField, selectContentClass, selectTriggerClass } from "./fields"

export function IterationPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasIterationNodeData
  onUpdate: (updates: Partial<CanvasIterationNodeData>) => void
}) {
  return (
    <div className="space-y-4">
      <Field label="Items" hint="A template that renders to a JSON array, or text with one item per line.">
        <div className="space-y-1.5">
          <TextField
            value={nodeData.source || ""}
            onChange={(source) => onUpdate({ source })}
            placeholder="{{ changed_files }}"
            mono
          />
          <Select value={nodeData.sourceMode ?? "json"} onValueChange={(v) => onUpdate({ sourceMode: v as CanvasIterationNodeData["sourceMode"] })}>
            <SelectTrigger className={selectTriggerClass}><SelectValue /></SelectTrigger>
            <SelectContent className={selectContentClass}>
              <SelectItem value="json">JSON array</SelectItem>
              <SelectItem value="lines">One item per line</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Field>
      <Field label="Concurrency" hint="How many items run at once. Default 4, max 16.">
        <NumberField value={nodeData.concurrency} onChange={(concurrency) => onUpdate({ concurrency })} placeholder="4" />
      </Field>
      <Field
        label="Result per item"
        hint="Evaluated after each round against the nodes inside the group plus {{ item }} and {{ index }}. All results are collected into a JSON array as this node's output."
      >
        <TextAreaField
          value={nodeData.output || ""}
          onChange={(output) => onUpdate({ output })}
          placeholder='{"file": {{ item | tojson }}, "review": {{ review | tojson }}}'
          mono
          minHeight="min-h-[80px]"
        />
      </Field>
      <p className="text-[10px] text-muted-foreground/50">
        Drag nodes into this group to build the body. Inside it, {"{{ item }}"} is the current element and every variable from outside the group is still available.
      </p>
    </div>
  )
}
