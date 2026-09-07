import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CanvasIfCase, CanvasIfNodeData } from "@/types/canvas-workflow"
import { ConditionBuilder } from "./ConditionBuilder"
import { labelClass } from "./fields"

function newCaseId(existing: CanvasIfCase[]): string {
  let n = existing.length + 1
  while (existing.some((c) => c.id === `case${n}`)) n += 1
  return `case${n}`
}

export function IfPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasIfNodeData
  onUpdate: (updates: Partial<CanvasIfNodeData>) => void
}) {
  const cases = nodeData.cases ?? []
  const setCase = (index: number, next: CanvasIfCase) =>
    onUpdate({ cases: cases.map((c, i) => (i === index ? next : c)) })

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className={labelClass}>Cases (first match wins)</label>
        {cases.map((c, index) => (
          <div key={c.id} className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-muted-foreground/70">{c.id}</span>
              <span className="text-[10px] text-muted-foreground/50">→ output handle "{c.id}"</span>
              <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={() => onUpdate({ cases: cases.filter((_, i) => i !== index) })}>
                <X className="h-3 w-3" />
              </Button>
            </div>
            <ConditionBuilder group={c} onChange={(next) => setCase(index, { ...c, ...next, id: c.id })} />
          </div>
        ))}
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[10px] font-mono text-muted-foreground/70">else</span>
          <span className="text-[10px] text-muted-foreground/50">taken when no case matches</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => onUpdate({ cases: [...cases, { id: newCaseId(cases), conditions: [{ variable: "", operator: "is_true" }], combinator: "and" }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          Add case
        </Button>
      </div>
    </div>
  )
}
