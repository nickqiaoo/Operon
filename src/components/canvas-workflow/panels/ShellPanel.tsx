import { Switch } from "@/components/ui/switch"
import type { CanvasShellNodeData } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField, TextField, VARIABLES_HINT } from "./fields"

export function ShellPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasShellNodeData
  onUpdate: (updates: Partial<CanvasShellNodeData>) => void
}) {
  return (
    <div className="space-y-4">
      <Field label="Command" hint={VARIABLES_HINT}>
        <TextAreaField
          value={nodeData.command || ""}
          onChange={(command) => onUpdate({ command })}
          placeholder="npm test 2>&1 | tail -n 40"
          mono
          minHeight="min-h-[100px]"
        />
      </Field>
      <Field label="Working directory" hint="Relative to the workspace root. Leave empty for the root.">
        <TextField
          value={nodeData.cwd || ""}
          onChange={(cwd) => onUpdate({ cwd: cwd.trim() === "" ? undefined : cwd })}
          placeholder="packages/app"
          mono
        />
      </Field>
      <Field label="Timeout (ms)" hint="Default 30000.">
        <NumberField value={nodeData.timeoutMs} onChange={(timeoutMs) => onUpdate({ timeoutMs })} placeholder="30000" />
      </Field>
      <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5">
        <div>
          <div className="text-xs font-medium">Fail on non-zero exit</div>
          <div className="text-[10px] text-muted-foreground/60">Off: stderr is appended to the output instead.</div>
        </div>
        <Switch
          checked={nodeData.failOnNonZero ?? true}
          onCheckedChange={(failOnNonZero) => onUpdate({ failOnNonZero })}
        />
      </div>
    </div>
  )
}
