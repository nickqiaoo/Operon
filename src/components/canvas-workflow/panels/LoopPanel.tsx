import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_LOOP_ITERATIONS, type CanvasLoopNodeData, type CanvasLoopVariable } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField, TextField, labelClass } from "./fields"
import { ConditionBuilder } from "./ConditionBuilder"

export function LoopPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasLoopNodeData
  onUpdate: (updates: Partial<CanvasLoopNodeData>) => void
}) {
  const variables = nodeData.variables ?? []
  const setVariable = (index: number, patch: Partial<CanvasLoopVariable>) =>
    onUpdate({ variables: variables.map((v, i) => (i === index ? { ...v, ...patch } : v)) })

  return (
    <div className="space-y-4">
      <Field label="Exit when" hint="Checked after each round against the nodes inside the group; {{ loop.index }} and every loop variable ({{ loop.<name> }}) are available.">
        <ConditionBuilder
          group={{ conditions: nodeData.untilConditions, combinator: nodeData.untilCombinator, expression: nodeData.until?.trim() ? nodeData.until : undefined }}
          onChange={(next) => onUpdate({
            untilConditions: next.conditions,
            untilCombinator: next.combinator,
            until: next.expression ?? "",
          })}
        />
      </Field>
      <Field label="Max rounds" hint={`Hard cap, required. At most ${MAX_LOOP_ITERATIONS}.`}>
        <NumberField
          value={nodeData.maxIterations}
          onChange={(maxIterations) => onUpdate({ maxIterations: maxIterations ?? 5 })}
          placeholder="5"
        />
      </Field>

      <div className="space-y-2">
        <label className={labelClass}>Loop variables</label>
        {variables.map((variable, index) => (
          <div key={index} className="space-y-1.5 rounded-lg border border-border/40 bg-muted/10 p-2.5">
            <div className="flex items-center gap-1.5">
              <TextField value={variable.name} onChange={(name) => setVariable(index, { name })} placeholder="name" mono className="flex-1" />
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => onUpdate({ variables: variables.filter((_, i) => i !== index) })}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <TextField value={variable.initial} onChange={(initial) => setVariable(index, { initial })} placeholder="initial value (template)" mono />
            <TextField value={variable.next} onChange={(next) => setVariable(index, { next })} placeholder="next value after each round, e.g. {{ fixed_code }}" mono />
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => onUpdate({ variables: [...variables, { name: "", initial: "", next: "" }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          Add variable
        </Button>
      </div>

      <Field label="Output on exit" hint="Template evaluated when the loop ends; the result gets iterations and exhausted fields added.">
        <TextAreaField
          value={nodeData.output || ""}
          onChange={(output) => onUpdate({ output })}
          placeholder='{"code": {{ loop.code | tojson }}}'
          mono
          minHeight="min-h-[80px]"
        />
      </Field>
    </div>
  )
}
