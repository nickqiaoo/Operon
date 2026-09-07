import { useMemo, useState } from "react"
import { Braces, ChevronRight } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { cn } from "@/lib/utils"
import type { AvailableVariable } from "../hooks/useAvailableVariables"

function flatten(variables: AvailableVariable[]): AvailableVariable[] {
  const out: AvailableVariable[] = []
  const walk = (v: AvailableVariable, depth: number) => {
    out.push({ ...v, children: undefined, preview: v.preview, path: v.path })
    ;(v.children ?? []).forEach((c) => walk(c, depth + 1))
  }
  variables.forEach((v) => walk(v, 0))
  return out
}

/**
 * Lists what a template can reference and inserts `{{ path }}` on pick.
 * Controlled from outside so typing `{{` in a field can open it too.
 */
export function VariablePicker({
  variables,
  open,
  onOpenChange,
  onPick,
  className,
  query: externalQuery,
  keepFieldFocus = false,
  commandRef,
}: {
  variables: AvailableVariable[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
  className?: string
  /** Filter text supplied by the field (what the user typed after `{{`). */
  query?: string
  /** Leave focus in the field instead of the search box (typed-open mode). */
  keepFieldFocus?: boolean
  /** The Command root, so the field can forward Enter / arrow keys to it. */
  commandRef?: React.RefObject<HTMLDivElement | null>
}) {
  const [ownQuery, setOwnQuery] = useState("")
  const query = externalQuery ?? ownQuery
  const setQuery = externalQuery === undefined ? setOwnQuery : () => undefined
  const items = useMemo(() => flatten(variables), [variables])
  const groups = useMemo(() => ({
    node: items.filter((i) => i.source === "node"),
    group: items.filter((i) => i.source === "group"),
    caller: items.filter((i) => i.source === "caller"),
    env: items.filter((i) => i.source === "env"),
  }), [items])

  const renderItem = (item: AvailableVariable) => {
    const depth = item.path.split(/[.[]/).length - 1
    return (
      <CommandItem
        key={item.path}
        value={item.path}
        onSelect={() => { onPick(item.path); onOpenChange(false); setQuery("") }}
        className="flex items-center gap-2 text-xs"
      >
        {depth > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" style={{ marginLeft: (depth - 1) * 10 }} />}
        <span className="font-mono">{item.path}</span>
        {item.preview && <span className="ml-auto max-w-[45%] truncate text-[10px] text-muted-foreground/60">{item.preview}</span>}
      </CommandItem>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Insert variable"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-secondary-hover hover:text-foreground",
            open && "bg-secondary-hover text-foreground",
            className
          )}
        >
          <Braces className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[320px] p-0 border border-border/50 bg-popover shadow-float"
        // Radix would hand focus back to the {x} button; the caller re-focuses
        // the field so the user can keep typing after inserting a variable.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { if (keepFieldFocus) event.preventDefault() }}
      >
        <Command ref={commandRef}>
          {keepFieldFocus ? (
            <div className="border-b border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              {query ? <>Matching <span className="font-mono text-foreground">{query}</span> — Enter to insert, keep typing to narrow</> : "Keep typing to filter — Enter inserts the first match"}
              {/* Keeps cmdk's filter in sync with what the field says. */}
              <CommandInput value={query} onValueChange={() => undefined} className="sr-only h-0 p-0" tabIndex={-1} />
            </div>
          ) : (
            <CommandInput placeholder="Search variables…" value={query} onValueChange={setQuery} className="h-8 text-xs" />
          )}
          <CommandList className="max-h-[260px]">
            <CommandEmpty className="py-4 text-xs text-muted-foreground">
              {items.length === 0 ? "Nothing upstream yet. Connect a node before this one." : "No match."}
            </CommandEmpty>
            {groups.node.length > 0 && <CommandGroup heading="Upstream nodes">{groups.node.map(renderItem)}</CommandGroup>}
            {groups.group.length > 0 && <CommandGroup heading="This group">{groups.group.map(renderItem)}</CommandGroup>}
            {groups.caller.length > 0 && <CommandGroup heading="From calling workflows">{groups.caller.map(renderItem)}</CommandGroup>}
            {groups.env.length > 0 && <CommandGroup heading="Environment">{groups.env.map(renderItem)}</CommandGroup>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
