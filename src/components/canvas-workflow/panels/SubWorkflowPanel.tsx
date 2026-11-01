import { useMemo } from "react"
import { Loader2 } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useCanvasWorkflows } from "@/lib/canvas-workflow-queries"
import type { CanvasSubWorkflowNodeData } from "@/types/canvas-workflow"
import { VARIABLES_HINT, labelClass, selectContentClass, selectTriggerClass } from "./fields"
import { KeyValueList } from "./KeyValueList"

export function SubWorkflowPanel({
  nodeData,
  currentWorkflowId,
  onUpdate,
}: {
  nodeData: CanvasSubWorkflowNodeData
  currentWorkflowId?: number
  onUpdate: (updates: Partial<CanvasSubWorkflowNodeData>) => void
}) {
  // The library list the canvas page already holds; null while it first loads.
  const { workflows: all, isPending } = useCanvasWorkflows()
  const workflows = useMemo(
    () => (isPending ? null : all.filter((w) => w.id !== currentWorkflowId)),
    [isPending, all, currentWorkflowId],
  )

  const select = (value: string) => {
    const id = Number(value)
    const picked = workflows?.find((w) => w.id === id)
    onUpdate({ workflowId: id, workflowName: picked?.name })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className={labelClass}>Workflow</label>
        {workflows === null ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <Select value={nodeData.workflowId ? String(nodeData.workflowId) : ""} onValueChange={select}>
            <SelectTrigger className={selectTriggerClass}><SelectValue placeholder="Select a workflow" /></SelectTrigger>
            <SelectContent className={selectContentClass}>
              {workflows.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <p className="text-[10px] text-muted-foreground/50">
          The child's End node outputs become this node's output: {"{{ call.summary }}"}.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>Variables for the child</label>
        <KeyValueList
          entries={nodeData.inputs ?? []}
          onChange={(inputs) => onUpdate({ inputs })}
          keyPlaceholder="name"
          valuePlaceholder="{{ item }}"
          addLabel="Add variable"
        />
        <p className="text-[10px] text-muted-foreground/50">
          Inside the child workflow these are plain variables: a row named <code>file</code> is {"{{ file }}"} there. {VARIABLES_HINT}
        </p>
      </div>
    </div>
  )
}
