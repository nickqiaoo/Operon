import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  DesignDeclaration,
  DesignSnapshot,
  DesignSubmission,
  DesignText,
} from "@/types/browser-runtime"

/**
 * The design ("adjust") panel rendered inside the annotation editor child
 * window. Edits the selected element's tweakable CSS; every change is diffed
 * against the captured snapshot and streamed back via `onChange` (only the
 * changed declarations + text), which the host forwards to the guest for live
 * preview. Mirrors codex's design editor card (spec §11).
 *
 * Uses native form controls only — Radix portals to the main window's
 * document.body, which renders in the wrong window once this tree is portaled
 * into a child window.
 */

interface Props {
  snapshot: DesignSnapshot
  /** Prior changes when re-editing an existing pin — pre-fills the controls. */
  initial?: DesignSubmission | null
  onChange: (declarations: DesignDeclaration[], text: DesignText | null) => void
}

const LABELS: Record<string, string> = {
  color: "Text color",
  "background-color": "Background",
  opacity: "Opacity",
  "font-family": "Font",
  "font-size": "Font size",
  "font-weight": "Font weight",
  "border-radius": "Border radius",
  "border-color": "Border color",
  "border-width": "Border width",
  width: "Width",
  height: "Height",
  "flex-direction": "Layout direction",
  "justify-content": "Distribution",
  "align-items": "Alignment",
  gap: "Spacing",
}

const FONT_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"]

const FLEX_DIRECTIONS = [
  { value: "row", label: "→" },
  { value: "row-reverse", label: "←" },
  { value: "column", label: "↓" },
  { value: "column-reverse", label: "↑" },
]
const JUSTIFY = [
  { value: "flex-start", label: "Start" },
  { value: "center", label: "Center" },
  { value: "flex-end", label: "End" },
  { value: "space-between", label: "Between" },
  { value: "space-around", label: "Around" },
  { value: "space-evenly", label: "Evenly" },
]
const ALIGN = [
  { value: "flex-start", label: "Start" },
  { value: "center", label: "Center" },
  { value: "flex-end", label: "End" },
  { value: "stretch", label: "Stretch" },
  { value: "baseline", label: "Base" },
]

// --- value helpers ----------------------------------------------------------

const toHexColor = (raw: string): string => {
  const v = raw.trim()
  const hex = v.match(/^#([\da-f]{3}|[\da-f]{6})$/i)
  if (hex) {
    const h = hex[1]
    return h.length === 3
      ? `#${h
          .split("")
          .map((c) => c + c)
          .join("")}`
      : `#${h}`
  }
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
  if (!rgb) return "#000000"
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
    .join("")}`
}

const parsePx = (raw: string): number | null => {
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

const roundToStep = (n: number, step: number): number => {
  const r = Math.round(n / step) * step
  return Number(r.toFixed(step < 1 ? 2 : 0))
}

// --- subcomponents -----------------------------------------------------------

const labelCls = "min-w-0 flex-1 truncate text-xs text-muted-foreground"
const fieldCls =
  "h-7 rounded-md border border-border/50 bg-background px-2 text-right font-mono text-xs text-foreground outline-none transition-colors focus:border-border"

function Row({
  label,
  changed,
  onReset,
  children,
  scrubHandlers,
}: {
  label: string
  changed: boolean
  onReset: () => void
  children: React.ReactNode
  scrubHandlers?: React.HTMLAttributes<HTMLSpanElement>
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        {...scrubHandlers}
        className={cn(labelCls, scrubHandlers && "cursor-ew-resize select-none")}
      >
        {label}
      </span>
      {changed ? (
        <button
          type="button"
          onClick={onReset}
          title="Reset"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <div className="flex w-[150px] shrink-0 items-center">{children}</div>
    </div>
  )
}

function ColorField({
  property,
  value,
  previousValue,
  onChange,
}: {
  property: string
  value: string
  previousValue: string
  onChange: (property: string, value: string) => void
}) {
  return (
    <Row
      label={LABELS[property] ?? property}
      changed={value !== previousValue}
      onReset={() => onChange(property, previousValue)}
    >
      <div className="flex h-7 w-full items-center gap-2 rounded-md border border-border/50 bg-background px-2">
        <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border/50">
          <span
            className="absolute inset-0"
            style={{ backgroundColor: value }}
          />
          <input
            type="color"
            value={toHexColor(value)}
            onChange={(e) => onChange(property, e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {value}
        </span>
      </div>
    </Row>
  )
}

function NumberField({
  property,
  value,
  previousValue,
  unit,
  step,
  min,
  max,
  onChange,
}: {
  property: string
  value: string
  previousValue: string
  unit: string
  step: number
  min?: number
  max?: number
  onChange: (property: string, value: string) => void
}) {
  const num = parsePx(value)
  const dragRef = useRef<{ startX: number; startVal: number } | null>(null)

  const setNum = (n: number) => {
    let next = n
    if (min != null) next = Math.max(min, next)
    if (max != null) next = Math.min(max, next)
    onChange(property, `${roundToStep(next, step)}${unit}`)
  }

  const scrub: React.HTMLAttributes<HTMLSpanElement> | undefined =
    num == null
      ? undefined
      : {
          onPointerDown: (e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dragRef.current = { startX: e.clientX, startVal: num }
          },
          onPointerMove: (e) => {
            if (dragRef.current == null) return
            const delta = e.clientX - dragRef.current.startX
            setNum(dragRef.current.startVal + delta * step)
          },
          onPointerUp: (e) => {
            dragRef.current = null
            e.currentTarget.releasePointerCapture(e.pointerId)
          },
        }

  return (
    <Row
      label={LABELS[property] ?? property}
      changed={value !== previousValue}
      onReset={() => onChange(property, previousValue)}
      scrubHandlers={scrub}
    >
      <div className="flex w-full items-center gap-1.5">
        {num == null ? (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(property, e.target.value)}
            className={cn(fieldCls, "w-full")}
          />
        ) : (
          <>
            <input
              type="number"
              value={num}
              step={step}
              min={min}
              max={max}
              onChange={(e) => {
                const n = parseFloat(e.target.value)
                if (Number.isFinite(n)) setNum(n)
              }}
              className={cn(fieldCls, "w-full")}
            />
            {unit ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {unit}
              </span>
            ) : null}
          </>
        )}
      </div>
    </Row>
  )
}

function SelectField({
  property,
  value,
  previousValue,
  options,
  onChange,
}: {
  property: string
  value: string
  previousValue: string
  options: string[]
  onChange: (property: string, value: string) => void
}) {
  const opts = options.includes(value) ? options : [value, ...options]
  return (
    <Row
      label={LABELS[property] ?? property}
      changed={value !== previousValue}
      onReset={() => onChange(property, previousValue)}
    >
      <select
        value={value}
        onChange={(e) => onChange(property, e.target.value)}
        className={cn(fieldCls, "w-full text-left")}
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Row>
  )
}

function TextField({
  property,
  label,
  value,
  previousValue,
  onChange,
}: {
  property: string
  label: string
  value: string
  previousValue: string
  onChange: (property: string, value: string) => void
}) {
  return (
    <Row
      label={label}
      changed={value !== previousValue}
      onReset={() => onChange(property, previousValue)}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(property, e.target.value)}
        className={cn(fieldCls, "w-full text-left")}
      />
    </Row>
  )
}

function SegmentField({
  property,
  value,
  previousValue,
  options,
  onChange,
}: {
  property: string
  value: string
  previousValue: string
  options: { value: string; label: string }[]
  onChange: (property: string, value: string) => void
}) {
  return (
    <Row
      label={LABELS[property] ?? property}
      changed={value !== previousValue}
      onReset={() => onChange(property, previousValue)}
    >
      <div className="flex w-full flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(property, o.value)}
            className={cn(
              "h-6 rounded border px-1.5 text-[11px] transition-colors",
              value === o.value
                ? "border-border/60 bg-secondary text-secondary-foreground"
                : "border-border/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  )
}

/** Four-sided box editor (padding / margin). */
function BoxField({
  title,
  sides,
  values,
  previous,
  onChange,
}: {
  title: string
  sides: { property: string; label: string }[]
  values: Record<string, string>
  previous: Record<string, string>
  onChange: (property: string, value: string) => void
}) {
  const changed = sides.some((s) => values[s.property] !== previous[s.property])
  return (
    <div className="py-0.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">{title}</span>
        {changed ? (
          <button
            type="button"
            onClick={() => sides.forEach((s) => onChange(s.property, previous[s.property]))}
            title="Reset"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-4 gap-1">
        {sides.map((s) => {
          const num = parsePx(values[s.property])
          return (
            <div key={s.property} className="flex flex-col items-center gap-0.5">
              <input
                type="number"
                value={num ?? 0}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  onChange(s.property, `${Number.isFinite(n) ? n : 0}px`)
                }}
                className={cn(
                  fieldCls,
                  "w-full px-1 text-center",
                  values[s.property] !== previous[s.property] && "border-border/60"
                )}
              />
              <span className="text-[10px] text-muted-foreground">{s.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GroupDivider() {
  return <div className="my-1.5 border-t border-border/40" />
}

// --- panel -------------------------------------------------------------------

export function AnnotationDesignPanel({ snapshot, initial, onChange }: Props) {
  const prev = useMemo(() => {
    const m: Record<string, string> = {}
    for (const d of snapshot.declarations) m[d.property] = d.previousValue
    return m
  }, [snapshot])

  const [values, setValues] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const d of snapshot.declarations) m[d.property] = d.value
    // Re-editing: overlay the prior changes so they show as changed + survive submit.
    if (initial != null) {
      for (const d of initial.declarations) if (d.property in m) m[d.property] = d.value
    }
    return m
  })
  const [text, setText] = useState(initial?.text?.value ?? snapshot.text?.value ?? "")

  // Diff against the snapshot and stream the changed-only declarations + text
  // up for live preview. Effect (not inline in the setters) so emission stays a
  // pure consequence of state and fires once per change, not twice in StrictMode.
  useEffect(() => {
    const changed: DesignDeclaration[] = snapshot.declarations
      .filter((d) => (values[d.property] ?? d.value) !== d.previousValue)
      .map((d) => ({
        property: d.property,
        value: values[d.property] ?? d.value,
        previousValue: d.previousValue,
      }))
    const textChange: DesignText | null =
      snapshot.text != null && text !== snapshot.text.previousValue
        ? { value: text, previousValue: snapshot.text.previousValue }
        : null
    onChange(changed, textChange)
  }, [values, text, snapshot, onChange])

  const set = useCallback((property: string, value: string) => {
    setValues((cur) => ({ ...cur, [property]: value }))
  }, [])

  const setTextContent = useCallback((_property: string, value: string) => {
    setText(value)
  }, [])

  const has = (property: string) => property in values
  const v = (property: string) => values[property] ?? ""

  return (
    <div className="flex flex-col gap-0.5 px-0.5 text-foreground">
      {snapshot.text != null ? (
        <>
          <TextField
            property="__text"
            label="Text"
            value={text}
            previousValue={snapshot.text.previousValue}
            onChange={setTextContent}
          />
          <GroupDivider />
        </>
      ) : null}

      {has("color") ? (
        <ColorField property="color" value={v("color")} previousValue={prev.color} onChange={set} />
      ) : null}
      {has("background-color") ? (
        <ColorField
          property="background-color"
          value={v("background-color")}
          previousValue={prev["background-color"]}
          onChange={set}
        />
      ) : null}
      {has("opacity") ? (
        <NumberField
          property="opacity"
          value={v("opacity")}
          previousValue={prev.opacity}
          unit=""
          step={0.05}
          min={0}
          max={1}
          onChange={set}
        />
      ) : null}

      <GroupDivider />
      {has("font-family") ? (
        <TextField
          property="font-family"
          label={LABELS["font-family"]}
          value={v("font-family")}
          previousValue={prev["font-family"]}
          onChange={set}
        />
      ) : null}
      {has("font-size") ? (
        <NumberField
          property="font-size"
          value={v("font-size")}
          previousValue={prev["font-size"]}
          unit="px"
          step={1}
          min={0}
          onChange={set}
        />
      ) : null}
      {has("font-weight") ? (
        <SelectField
          property="font-weight"
          value={v("font-weight")}
          previousValue={prev["font-weight"]}
          options={FONT_WEIGHTS}
          onChange={set}
        />
      ) : null}

      <GroupDivider />
      {has("border-radius") ? (
        <NumberField
          property="border-radius"
          value={v("border-radius")}
          previousValue={prev["border-radius"]}
          unit="px"
          step={1}
          min={0}
          onChange={set}
        />
      ) : null}
      {has("border-color") ? (
        <ColorField
          property="border-color"
          value={v("border-color")}
          previousValue={prev["border-color"]}
          onChange={set}
        />
      ) : null}
      {has("border-width") ? (
        <NumberField
          property="border-width"
          value={v("border-width")}
          previousValue={prev["border-width"]}
          unit="px"
          step={1}
          min={0}
          onChange={set}
        />
      ) : null}

      <GroupDivider />
      {has("width") ? (
        <NumberField
          property="width"
          value={v("width")}
          previousValue={prev.width}
          unit="px"
          step={1}
          min={0}
          onChange={set}
        />
      ) : null}
      {has("height") ? (
        <NumberField
          property="height"
          value={v("height")}
          previousValue={prev.height}
          unit="px"
          step={1}
          min={0}
          onChange={set}
        />
      ) : null}

      {snapshot.isFlex ? (
        <>
          <GroupDivider />
          <SegmentField
            property="flex-direction"
            value={v("flex-direction")}
            previousValue={prev["flex-direction"]}
            options={FLEX_DIRECTIONS}
            onChange={set}
          />
          <SegmentField
            property="justify-content"
            value={v("justify-content")}
            previousValue={prev["justify-content"]}
            options={JUSTIFY}
            onChange={set}
          />
          <SegmentField
            property="align-items"
            value={v("align-items")}
            previousValue={prev["align-items"]}
            options={ALIGN}
            onChange={set}
          />
          {has("gap") ? (
            <NumberField
              property="gap"
              value={v("gap")}
              previousValue={prev.gap}
              unit="px"
              step={1}
              min={0}
              onChange={set}
            />
          ) : null}
        </>
      ) : null}

      <GroupDivider />
      <BoxField
        title="Padding"
        sides={[
          { property: "padding-top", label: "T" },
          { property: "padding-right", label: "R" },
          { property: "padding-bottom", label: "B" },
          { property: "padding-left", label: "L" },
        ]}
        values={values}
        previous={prev}
        onChange={set}
      />
      <BoxField
        title="Margin"
        sides={[
          { property: "margin-top", label: "T" },
          { property: "margin-right", label: "R" },
          { property: "margin-bottom", label: "B" },
          { property: "margin-left", label: "L" },
        ]}
        values={values}
        previous={prev}
        onChange={set}
      />
    </div>
  )
}
