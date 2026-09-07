import { useState } from "react"
import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { CanvasCondition, CanvasConditionGroup, CanvasConditionOperator } from "@/types/canvas-workflow"
import { VariablePicker } from "./VariablePicker"
import { useVariableScope } from "./variable-scope"
import { TextField, inputClass, selectContentClass, selectTriggerClass } from "./fields"
import { Input } from "@/components/ui/input"

const OPERATORS: Array<{ id: CanvasConditionOperator; label: string; unary?: boolean }> = [
  { id: "is_true", label: "is true", unary: true },
  { id: "is_false", label: "is false", unary: true },
  { id: "not_empty", label: "is not empty", unary: true },
  { id: "is_empty", label: "is empty", unary: true },
  { id: "equals", label: "equals" },
  { id: "not_equals", label: "does not equal" },
  { id: "contains", label: "contains" },
  { id: "not_contains", label: "does not contain" },
  { id: "gt", label: ">" },
  { id: "gte", label: "≥" },
  { id: "lt", label: "<" },
  { id: "lte", label: "≤" },
  { id: "matches", label: "matches regex" },
]

function VariableInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const variables = useVariableScope()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        value={value}
        placeholder="review.passed"
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, "font-mono text-xs pr-7")}
      />
      <VariablePicker
        variables={variables}
        open={open}
        onOpenChange={setOpen}
        onPick={onChange}
        className="absolute right-1.5 top-1/2 -translate-y-1/2"
      />
    </div>
  )
}

/**
 * Row-by-row conditions (variable · operator · value) with an advanced
 * switch for a hand-written expression. The server compiles rows to the
 * same expression language, so both forms behave identically.
 */
export function ConditionBuilder({
  group,
  onChange,
}: {
  group: CanvasConditionGroup
  onChange: (next: CanvasConditionGroup) => void
}) {
  const rows = group.conditions ?? []
  const advanced = typeof group.expression === "string"

  const setRow = (index: number, patch: Partial<CanvasCondition>) =>
    onChange({ ...group, conditions: rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) })

  return (
    <div className="space-y-2">
      {advanced ? (
        <TextField
          value={group.expression ?? ""}
          onChange={(expression) => onChange({ ...group, expression })}
          placeholder='review.passed and "FAIL" not in tests'
          mono
        />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, index) => {
            const op = OPERATORS.find((o) => o.id === row.operator) ?? OPERATORS[0]
            return (
              <div key={index} className="space-y-1">
                {index > 0 && (
                  <button
                    type="button"
                    className="ml-1 text-[10px] font-mono uppercase text-muted-foreground/70 hover:text-foreground"
                    onClick={() => onChange({ ...group, combinator: group.combinator === "or" ? "and" : "or" })}
                    title="Toggle and / or"
                  >
                    {group.combinator === "or" ? "or" : "and"}
                  </button>
                )}
                <div className="flex items-center gap-1.5">
                  <VariableInput value={row.variable} onChange={(variable) => setRow(index, { variable })} />
                  <Select value={row.operator} onValueChange={(v) => setRow(index, { operator: v as CanvasConditionOperator })}>
                    <SelectTrigger className={cn(selectTriggerClass, "w-[124px] shrink-0 text-xs")}><SelectValue /></SelectTrigger>
                    <SelectContent className={selectContentClass}>
                      {OPERATORS.map((o) => <SelectItem key={o.id} value={o.id} className="text-xs">{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => onChange({ ...group, conditions: rows.filter((_, i) => i !== index) })}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {!op.unary && (
                  <TextField
                    value={row.value ?? ""}
                    onChange={(value) => setRow(index, { value })}
                    placeholder={row.operator === "matches" ? "regular expression" : "value"}
                    mono
                    template={false}
                    className="pr-[34px]"
                  />
                )}
              </div>
            )
          })}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onChange({ ...group, conditions: [...rows, { variable: "", operator: "is_true" }] })}
          >
            <Plus className="h-3.5 w-3.5" />
            Add condition
          </Button>
        </div>
      )}
      <button
        type="button"
        className="text-[10px] text-muted-foreground/60 hover:text-foreground"
        onClick={() => onChange(advanced ? { ...group, expression: undefined } : { ...group, expression: "" })}
      >
        {advanced ? "← Back to simple conditions" : "Write an expression instead"}
      </button>
    </div>
  )
}
