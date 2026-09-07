import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TextField } from "./fields"

export interface KeyValueEntry {
  key: string
  value: string
}

/** A small editable key/value table used for HTTP headers and End outputs. */
export function KeyValueList({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  valueMono,
}: {
  entries: KeyValueEntry[]
  onChange: (next: KeyValueEntry[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  valueMono?: boolean
}) {
  const set = (index: number, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))

  return (
    <div className="space-y-1.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <TextField
            value={entry.key}
            onChange={(key) => set(index, { key })}
            placeholder={keyPlaceholder}
            mono
            template={false}
            className="w-[38%]"
          />
          <TextField
            value={entry.value}
            onChange={(value) => set(index, { value })}
            placeholder={valuePlaceholder}
            mono={valueMono}
            className="flex-1"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => onChange([...entries, { key: "", value: "" }])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  )
}
