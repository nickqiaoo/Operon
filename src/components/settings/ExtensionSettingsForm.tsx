import { useCallback, useEffect, useMemo, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/lib/api"
import { useProviderModelOptions, useProviderModels } from "@/lib/provider-queries"
import { cn } from "@/lib/utils"
import type { ExtensionSettingsDTO, ExtensionSettingsIssue, ExtensionSettingsSchema } from "@/types/extension"
import { ModelCombobox } from "./ModelCombobox"

/**
 * One form for any extension's settings, rendered from the schema its manifest declares — no
 * settings page per extension. Titles and descriptions are the extension author's, shown as
 * written. Saving submits the whole value; the framework validates it and, when the extension is
 * loaded, reloads it onto the new value without interrupting open conversations.
 */
export function ExtensionSettingsForm({ extensionId, onSaved }: { extensionId: string; onSaved?: () => void }) {
  const [view, setView] = useState<ExtensionSettingsDTO | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveIssues, setSaveIssues] = useState<ExtensionSettingsIssue[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.extensionSettings(extensionId)
      if (res.error || !res.schema) throw new Error(res.error ?? "No settings")
      const next = { schema: res.schema, value: res.value ?? {}, issues: res.issues ?? [] }
      setView(next)
      setDraft(next.value)
      setSaveIssues([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [extensionId])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => view !== null && JSON.stringify(draft) !== JSON.stringify(view.value), [draft, view])
  const issuesByPath = useMemo(() => groupIssues(saveIssues), [saveIssues])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSaveIssues([])
    try {
      const res = await api.extensionSettingsSave(extensionId, draft)
      if (res.issues?.length) {
        setSaveIssues(res.issues)
        return
      }
      if (res.error || !res.schema) throw new Error(res.error ?? "Save failed")
      const next = { schema: res.schema, value: res.value ?? {}, issues: res.issues ?? [] }
      setView(next)
      setDraft(next.value)
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [draft, extensionId, onSaved])

  if (loading && !view) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <FormattedMessage id="settings.extensionSettings.loading" defaultMessage="Loading…" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {view && view.issues.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warn/40 bg-status-warn/5 p-3 text-xs text-status-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <FormattedMessage
              id="settings.extensionSettings.storedIssues"
              defaultMessage="Some saved settings no longer fit this version of the extension and are using their defaults:"
            />
            <ul className="list-disc pl-4">
              {view.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path ? <span className="font-mono">{issue.path}</span> : null} {issue.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      {saveIssues.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.extensionSettings.invalid" defaultMessage="Not saved — fix the highlighted fields." />
        </div>
      )}

      {view && (
        <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
          <ObjectFields schema={view.schema} value={draft} path="" issues={issuesByPath} onChange={(next) => setDraft(next as Record<string, unknown>)} />
          {issuesByPath.get("")?.map((message) => <FieldIssue key={message} message={message} />)}
          <div className="flex items-center gap-2 border-t border-border/40 pt-4">
            <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.extensionSettings.save" defaultMessage="Save" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={!dirty || saving} onClick={() => { setDraft(view.value); setSaveIssues([]) }}>
              <RotateCcw className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.extensionSettings.discard" defaultMessage="Discard changes" />
            </Button>
            {dirty && (
              <span className="text-[11px] text-muted-foreground">
                <FormattedMessage id="settings.extensionSettings.applyHint" defaultMessage="Applies when saved; open conversations keep running." />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Field rendering ─────────────────────────────────────────────────────────

interface FieldProps {
  schema: ExtensionSettingsSchema
  value: unknown
  path: string
  issues: Map<string, string[]>
  onChange: (value: unknown) => void
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`
}

function groupIssues(issues: readonly ExtensionSettingsIssue[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const issue of issues) out.set(issue.path, [...(out.get(issue.path) ?? []), issue.message])
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Fields of an object, by `x-order` and then declaration order. */
function orderedProperties(schema: ExtensionSettingsSchema): Array<[string, ExtensionSettingsSchema]> {
  return Object.entries(schema.properties ?? {})
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry[1]["x-order"] ?? Number.MAX_SAFE_INTEGER) - (b.entry[1]["x-order"] ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ entry }) => entry)
}

/** A fresh value for a new table entry or array element: its defaults, and its key for a required
 *  string field nothing else fills (a teammate type's `title`, say). */
function initialValue(schema: ExtensionSettingsSchema, key?: string): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default)
  switch (schema.type) {
    case "object": {
      const out: Record<string, unknown> = {}
      for (const [name, field] of Object.entries(schema.properties ?? {})) {
        const value = field.default !== undefined || field.type === "object" ? initialValue(field) : undefined
        if (value !== undefined && !(isRecord(value) && Object.keys(value).length === 0)) out[name] = value
        else if (schema.required?.includes(name) && field.type === "string") out[name] = key ?? ""
      }
      return out
    }
    case "array":
      return []
    case "string":
      return schema.enum?.[0] ?? ""
    case "boolean":
      return false
    default:
      return schema.enum?.[0] ?? schema.minimum ?? 0
  }
}

function Field(props: FieldProps & { name: string; required: boolean }) {
  const { schema, path, issues, name, required } = props
  const label = schema.title ?? name
  const messages = issues.get(path) ?? []
  if (schema.type === "object") {
    return (
      <fieldset className="space-y-3 rounded-lg border border-border/40 bg-background/40 p-3">
        <legend className="px-1 text-xs font-semibold">{label}</legend>
        {schema.description && <p className="text-[11px] text-muted-foreground">{schema.description}</p>}
        {schema.additionalProperties ? <TableField {...props} /> : <ObjectFields {...props} />}
        {messages.map((message) => <FieldIssue key={message} message={message} />)}
      </fieldset>
    )
  }
  if (schema.type === "array") {
    return (
      <div className="space-y-2">
        <FieldLabel label={label} description={schema.description} required={required} />
        <ArrayField {...props} />
        {messages.map((message) => <FieldIssue key={message} message={message} />)}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[minmax(120px,160px)_1fr] items-start gap-x-4 gap-y-1">
      <FieldLabel label={label} description={undefined} required={required} className="pt-2" />
      <div className="min-w-0 space-y-1">
        <LeafField {...props} invalid={messages.length > 0} />
        {schema.description && <p className="text-[11px] text-muted-foreground">{schema.description}</p>}
        {messages.map((message) => <FieldIssue key={message} message={message} />)}
      </div>
    </div>
  )
}

function ObjectFields({ schema, value, path, issues, onChange }: FieldProps) {
  const record = isRecord(value) ? value : {}
  return (
    <div className="space-y-3">
      {orderedProperties(schema).map(([key, field]) => (
        <Field
          key={key}
          name={key}
          schema={field}
          value={record[key]}
          path={join(path, key)}
          issues={issues}
          required={schema.required?.includes(key) ?? false}
          onChange={(next) => {
            const copy = { ...record }
            if (next === undefined) delete copy[key]
            else copy[key] = next
            onChange(copy)
          }}
        />
      ))}
    </div>
  )
}

/** An object whose keys come and go (`additionalProperties`): add, open, remove entries. */
function TableField({ schema, value, path, issues, onChange }: FieldProps) {
  const intl = useIntl()
  const record = isRecord(value) ? value : {}
  const entrySchema = schema.additionalProperties!
  const pattern = schema.propertyNames?.pattern
  const [newKey, setNewKey] = useState("")
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const fixed = new Set(Object.keys(schema.properties ?? {}))
  const entries = Object.entries(record).filter(([key]) => !fixed.has(key))
  const trimmed = newKey.trim()
  const keyProblem = !trimmed
    ? undefined
    : hasKey(record, trimmed)
      ? intl.formatMessage({ id: "settings.extensionSettings.keyTaken", defaultMessage: "“{key}” already exists." }, { key: trimmed })
      : pattern && !new RegExp(pattern, "u").test(trimmed)
        ? intl.formatMessage({ id: "settings.extensionSettings.keyPattern", defaultMessage: "Must match {pattern}" }, { pattern })
        : undefined
  const add = () => {
    if (!trimmed || keyProblem) return
    onChange({ ...record, [trimmed]: initialValue(entrySchema, trimmed) })
    setOpen((current) => ({ ...current, [trimmed]: true }))
    setNewKey("")
  }
  return (
    <div className="space-y-2">
      {fixed.size > 0 && <ObjectFields schema={schema} value={record} path={path} issues={issues} onChange={onChange} />}
      {entries.map(([key, entry]) => {
        const entryPath = join(path, key)
        const hasIssue = [...issues.keys()].some((p) => p === entryPath || p.startsWith(`${entryPath}.`))
        const expanded = open[key] ?? hasIssue
        const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined
        return (
          <div key={key} className={cn("rounded-lg border bg-background/60", hasIssue ? "border-destructive/50" : "border-border/40")}>
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                onClick={() => setOpen((current) => ({ ...current, [key]: !expanded }))}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <span className="font-mono text-muted-foreground">{key}</span>
                {title && <span className="truncate font-medium">{title}</span>}
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-muted-foreground hover:text-status-error"
                aria-label={intl.formatMessage({ id: "settings.extensionSettings.remove", defaultMessage: "Remove" })}
                onClick={() => {
                  const copy = { ...record }
                  delete copy[key]
                  onChange(copy)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {expanded && (
              <div className="border-t border-border/40 p-3">
                <EntryBody schema={entrySchema} value={entry} path={entryPath} issues={issues} onChange={(next) => onChange({ ...record, [key]: next })} />
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-start gap-2">
        <div className="space-y-1">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder={intl.formatMessage({ id: "settings.extensionSettings.newKey", defaultMessage: "New key" })}
            className={cn("h-8 w-56 border-border/50 font-mono text-xs", keyProblem && "border-destructive/60")}
            onKeyDown={(e) => {
              if (e.key === "Enter") add()
            }}
          />
          {keyProblem && <FieldIssue message={keyProblem} />}
        </div>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={add} disabled={!trimmed || keyProblem !== undefined}>
          <Plus className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.extensionSettings.add" defaultMessage="Add" />
        </Button>
      </div>
    </div>
  )
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** The inside of a table entry or array element: an object's fields, or a single leaf. */
function EntryBody(props: FieldProps) {
  const { schema, path, issues } = props
  if (schema.type === "object") return schema.additionalProperties ? <TableField {...props} /> : <ObjectFields {...props} />
  if (schema.type === "array") return <ArrayField {...props} />
  const messages = issues.get(path) ?? []
  return (
    <div className="space-y-1">
      <LeafField {...props} invalid={messages.length > 0} />
      {messages.map((message) => <FieldIssue key={message} message={message} />)}
    </div>
  )
}

function ArrayField({ schema, value, path, issues, onChange }: FieldProps) {
  const intl = useIntl()
  const items = Array.isArray(value) ? value : []
  const itemSchema = schema.items!
  const move = (from: number, to: number) => {
    const copy = [...items]
    const [item] = copy.splice(from, 1)
    copy.splice(to, 0, item)
    onChange(copy)
  }
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/60 p-2">
          <div className="min-w-0 flex-1">
            <EntryBody
              schema={itemSchema}
              value={item}
              path={join(path, index)}
              issues={issues}
              onChange={(next) => onChange(items.map((current, i) => (i === index ? next : current)))}
            />
          </div>
          <div className="flex shrink-0 items-center">
            <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={index === 0} onClick={() => move(index, index - 1)}
              aria-label={intl.formatMessage({ id: "settings.extensionSettings.moveUp", defaultMessage: "Move up" })}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={index === items.length - 1} onClick={() => move(index, index + 1)}
              aria-label={intl.formatMessage({ id: "settings.extensionSettings.moveDown", defaultMessage: "Move down" })}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-1.5 text-muted-foreground hover:text-status-error" onClick={() => onChange(items.filter((_, i) => i !== index))}
              aria-label={intl.formatMessage({ id: "settings.extensionSettings.remove", defaultMessage: "Remove" })}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onChange([...items, initialValue(itemSchema)])}>
        <Plus className="h-3.5 w-3.5" />
        <FormattedMessage id="settings.extensionSettings.add" defaultMessage="Add" />
      </Button>
    </div>
  )
}

const UNSET = "__unset__"

function LeafField({ schema, value, onChange, invalid }: FieldProps & { invalid: boolean }) {
  const intl = useIntl()
  const inputClass = cn("h-8 border-border/50 text-xs", invalid && "border-destructive/60")
  if (schema.format === "model") return <ModelField value={typeof value === "string" ? value : ""} onChange={onChange} />
  if (schema.format === "permission-mode") return <PermissionModeField value={typeof value === "string" ? value : undefined} onChange={onChange} invalid={invalid} />
  if (schema.enum) {
    const current = value === undefined ? UNSET : JSON.stringify(value)
    return (
      <Select value={current} onValueChange={(next) => onChange(next === UNSET ? undefined : JSON.parse(next))}>
        <SelectTrigger className={cn("w-full max-w-[280px] bg-background/80", inputClass)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {value === undefined && (
            <SelectItem value={UNSET} className="text-xs text-muted-foreground">
              <FormattedMessage id="settings.extensionSettings.unset" defaultMessage="Not set" />
            </SelectItem>
          )}
          {schema.enum.map((option) => (
            <SelectItem key={JSON.stringify(option)} value={JSON.stringify(option)} className="text-xs">
              {String(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  switch (schema.type) {
    case "boolean":
      return <Switch checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
    case "integer":
    case "number":
      return (
        <Input
          type="number"
          value={typeof value === "number" ? value : ""}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          placeholder={intl.formatMessage({ id: "settings.extensionSettings.empty", defaultMessage: "Not set" })}
          className={cn("w-48", inputClass)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      )
    default:
      if (schema["x-multiline"]) {
        return (
          <Textarea
            value={typeof value === "string" ? value : ""}
            maxLength={schema.maxLength}
            className={cn("min-h-[72px] border-border/50 text-xs", invalid && "border-destructive/60")}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          />
        )
      }
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          maxLength={schema.maxLength}
          className={cn("max-w-[420px]", inputClass)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      )
  }
}

/** `format: "model"` — the app's own model picker; empty means "not set". */
function ModelField({ value, onChange }: { value: string; onChange: (value: unknown) => void }) {
  const intl = useIntl()
  const models = useProviderModelOptions("custom")
  return (
    <ModelCombobox
      value={value}
      models={models ?? []}
      loading={models === null}
      defaultLabel={intl.formatMessage({ id: "settings.extensionSettings.modelDefault", defaultMessage: "Not set" })}
      className="max-w-[420px]"
      onValueChange={(modelId) => onChange(modelId === "" ? undefined : modelId)}
    />
  )
}

/** `format: "permission-mode"` — the app's own mode names; their ids are the framework's modes. */
function PermissionModeField({ value, onChange, invalid }: { value: string | undefined; onChange: (value: unknown) => void; invalid: boolean }) {
  const { data } = useProviderModels("custom")
  const modes = data?.modes?.length ? data.modes : FALLBACK_MODES.map((id) => ({ id, name: id }))
  return (
    <Select value={value ?? UNSET} onValueChange={(next) => onChange(next === UNSET ? undefined : next)}>
      <SelectTrigger className={cn("h-8 w-full max-w-[240px] border-border/50 bg-background/80 text-xs", invalid && "border-destructive/60")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {value === undefined && (
          <SelectItem value={UNSET} className="text-xs text-muted-foreground">
            <FormattedMessage id="settings.extensionSettings.unset" defaultMessage="Not set" />
          </SelectItem>
        )}
        {modes.map((mode) => (
          <SelectItem key={mode.id} value={mode.id} className="text-xs">
            {mode.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const FALLBACK_MODES = ["manual", "workspace", "auto", "yolo"] as const

function FieldLabel({ label, description, required, className }: { label: string; description?: string; required: boolean; className?: string }) {
  return (
    <div className={cn("space-y-0.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
    </div>
  )
}

function FieldIssue({ message }: { message: string }) {
  return <p className="text-[11px] text-destructive">{message}</p>
}
