import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { rootNames } from "../hooks/useAvailableVariables"
import { useVariableScope } from "./variable-scope"
import { VariablePicker } from "./VariablePicker"

export const labelClass = "text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60"
export const inputClass = "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none h-8 text-sm"
export const textareaClass = "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none resize-none text-sm code-scrollbar"
export const selectTriggerClass = "h-8 text-sm bg-muted/25 border border-transparent hover:bg-muted/45 hover:border-border/40 shadow-none transition-colors focus-visible:border-border/50 focus-visible:ring-2 focus-visible:ring-border/30"
export const selectContentClass = "border border-border/40 bg-background/95 shadow-float backdrop-blur-sm"

export const VARIABLES_HINT = 'Variables: {{ name }} = output of the node named "name" (any node that ran before this one). JSON outputs are objects: {{ review.passed }}.'

/** Names nunjucks itself understands, so a template using them is not flagged. */
const BUILTIN_ROOTS = new Set(["true", "false", "none", "null", "range", "loop", "item", "index", "env", "not", "if", "else", "and", "or", "in", "is"])

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className={labelClass}>{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/50">{hint}</p>}
    </div>
  )
}

/**
 * Text inputs keep a local draft and push every keystroke up. The draft
 * resyncs when the node changes underneath (switching nodes reuses the panel).
 */
function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return [draft, setDraft]
}

/** `{{ foo.bar }}` → `foo`; ignores literals so `{{ "x" }}` and `{{ 3 }}` pass. */
function referencedRoots(text: string): string[] {
  const roots: string[] = []
  for (const match of text.matchAll(/\{\{\s*([A-Za-z_]\w*)/g)) roots.push(match[1])
  for (const match of text.matchAll(/\{%\s*(?:if|elif|for\s+\w+\s+in)\s+(?:not\s+)?([A-Za-z_]\w*)/g)) roots.push(match[1])
  return roots
}

/**
 * Shared behaviour of every template field: a `{x}` picker, opening it when
 * the user types `{{`, inserting at the caret, and a soft warning for roots
 * that no upstream node provides.
 */
function useTemplateField(
  value: string,
  onChange: (next: string) => void,
  elementRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  enabled: boolean
) {
  const variables = useVariableScope()
  const [draft, setDraft] = useDraft(value)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Where the `{{` that opened the picker starts; null when opened from the button. */
  const typedAnchor = useRef<number | null>(null)
  const [typedQuery, setTypedQuery] = useState("")
  const commandRef = useRef<HTMLDivElement | null>(null)

  const unknownRoots = useMemo(() => {
    if (!enabled || variables.length === 0) return []
    const known = rootNames(variables)
    return [...new Set(referencedRoots(draft))].filter((root) => !known.has(root) && !BUILTIN_ROOTS.has(root))
  }, [draft, variables, enabled])

  const commit = (next: string) => {
    setDraft(next)
    onChange(next)
  }

  const closePicker = () => {
    typedAnchor.current = null
    setTypedQuery("")
    setPickerOpen(false)
  }

  const handleChange = (next: string, caret: number | null) => {
    commit(next)
    if (!enabled || caret === null) return

    // Typed-open mode: what follows the `{{` filters the list; a `}` or a
    // line break means the user is finishing the expression by hand.
    if (typedAnchor.current !== null && pickerOpen) {
      const anchor = typedAnchor.current
      if (caret < anchor + 2 || next.slice(anchor, anchor + 2) !== "{{") { closePicker(); return }
      const typed = next.slice(anchor + 2, caret)
      if (/[}\n]/.test(typed)) { closePicker(); return }
      setTypedQuery(typed.trim())
      return
    }
    if (next.slice(Math.max(0, caret - 2), caret) === "{{") {
      typedAnchor.current = caret - 2
      setTypedQuery("")
      setPickerOpen(true)
    }
  }

  const insert = (path: string) => {
    const el = elementRef.current
    const caretNow = el?.selectionStart ?? draft.length
    const selectionEnd = el?.selectionEnd ?? draft.length
    const start = typedAnchor.current !== null ? typedAnchor.current : caretNow
    const end = typedAnchor.current !== null ? caretNow : selectionEnd
    const before = draft.slice(0, start)
    const after = draft.slice(end)
    const snippet = `{{ ${path} }}`
    const next = `${before}${snippet}${after}`
    closePicker()
    commit(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const caret = before.length + snippet.length
      el.setSelectionRange(caret, caret)
    })
  }

  /** Forward list navigation from the field to cmdk while the typed-open picker is up. */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!pickerOpen || typedAnchor.current === null) return
    if (event.key === "Escape") { event.preventDefault(); closePicker(); return }
    if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      commandRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true }))
    }
  }

  const onPickerOpenChange = (open: boolean) => {
    if (open) { typedAnchor.current = null; setTypedQuery(""); setPickerOpen(true) }
    else closePicker()
  }

  return {
    draft, variables, pickerOpen, handleChange, handleKeyDown, insert, unknownRoots, commandRef,
    onPickerOpenChange,
    typedOpen: pickerOpen && typedAnchor.current !== null,
    typedQuery,
  }
}

function UnknownRootsNote({ roots }: { roots: string[] }) {
  if (roots.length === 0) return null
  return (
    <p className="text-[10px] text-status-warn">
      {roots.length === 1 ? `"${roots[0]}" is not a known variable` : `Unknown variables: ${roots.map((r) => `"${r}"`).join(", ")}`}
    </p>
  )
}

export function TextField({
  value,
  onChange,
  placeholder,
  mono,
  className,
  template = true,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  mono?: boolean
  className?: string
  /** Offer the variable picker; off for plain identifiers like a header name. */
  template?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const field = useTemplateField(value, onChange, ref, template)
  return (
    <div className={cn("min-w-0", className)}>
      <div className="relative">
        <Input
          ref={ref}
          value={field.draft}
          placeholder={placeholder}
          onChange={(e) => field.handleChange(e.target.value, e.target.selectionStart)}
          onKeyDown={field.handleKeyDown}
          className={cn(inputClass, mono && "font-mono text-xs", template && "pr-7")}
        />
        {template && (
          <VariablePicker
            variables={field.variables}
            open={field.pickerOpen}
            onOpenChange={field.onPickerOpenChange}
            onPick={field.insert}
            query={field.typedOpen ? field.typedQuery : undefined}
            keepFieldFocus={field.typedOpen}
            commandRef={field.commandRef}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          />
        )}
      </div>
      <UnknownRootsNote roots={field.unknownRoots} />
    </div>
  )
}

export function TextAreaField({
  value,
  onChange,
  placeholder,
  mono,
  minHeight = "min-h-[120px]",
  className,
  template = true,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  mono?: boolean
  minHeight?: string
  className?: string
  template?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const field = useTemplateField(value, onChange, ref, template)
  return (
    <div>
      <div className="relative">
        <Textarea
          ref={ref}
          value={field.draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => field.handleChange(e.target.value, e.target.selectionStart)}
          onKeyDown={field.handleKeyDown}
          className={cn(textareaClass, minHeight, mono && "font-mono text-xs", template && "pr-7", className)}
        />
        {template && (
          <VariablePicker
            variables={field.variables}
            open={field.pickerOpen}
            onOpenChange={field.onPickerOpenChange}
            onPick={field.insert}
            query={field.typedOpen ? field.typedQuery : undefined}
            keepFieldFocus={field.typedOpen}
            commandRef={field.commandRef}
            className="absolute right-1.5 top-1.5"
          />
        )}
      </div>
      <UnknownRootsNote roots={field.unknownRoots} />
    </div>
  )
}

export function NumberField({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined
  onChange: (next: number | undefined) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useDraft(value === undefined ? "" : String(value))
  return (
    <Input
      type="number"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value)
        const parsed = Number(e.target.value)
        onChange(e.target.value.trim() === "" || Number.isNaN(parsed) ? undefined : parsed)
      }}
      className={inputClass}
    />
  )
}
