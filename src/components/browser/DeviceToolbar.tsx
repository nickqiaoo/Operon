import { useIntl } from "react-intl"
import { RotateCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WebviewInstance, WebviewState } from "./WebviewInstance"

interface Preset {
  label: string
  size: { width: number; height: number } | null
}

const PRESETS: Preset[] = [
  { label: "Responsive", size: null },
  { label: "iPhone SE", size: { width: 375, height: 667 } },
  { label: "iPhone 14/15", size: { width: 393, height: 852 } },
  { label: "iPhone 14 Pro Max", size: { width: 430, height: 932 } },
  { label: "Pixel 7", size: { width: 412, height: 915 } },
  { label: "iPad Mini", size: { width: 768, height: 1024 } },
  { label: "iPad Pro", size: { width: 1024, height: 1366 } },
]

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5]

const fieldCls =
  "h-7 rounded-md border border-border/50 bg-background px-2 text-xs text-foreground outline-none transition-colors focus:border-border"

/** A base size to start from when typing a dimension while in Responsive mode. */
const DEFAULT_SIZE = { width: 393, height: 852 }

/**
 * Chrome-DevTools-style device emulation bar. Resizes the
 * `<webview>` to a fixed viewport centered in a letterbox; the actual sizing is
 * applied by `WebviewInstance.positionVisible` from `state.deviceSize`.
 */
export function DeviceToolbar({
  instance,
  state,
}: {
  instance: WebviewInstance
  state: WebviewState
}) {
  const intl = useIntl()
  const size = state.deviceSize
  // When responsive (no fixed size) the fields still show the live viewport
  // size — matching codex, where "Responsive" reads back the current dimensions.
  const display = size ?? state.viewportSize
  const activeLabel =
    size == null
      ? "Responsive"
      : PRESETS.find((p) => p.size?.width === size.width && p.size?.height === size.height)
          ?.label ?? "Custom"

  const onPreset = (label: string) => {
    if (label === "Custom") return
    instance.setDeviceSize(PRESETS.find((p) => p.label === label)?.size ?? null)
  }
  const onDim = (dim: "width" | "height", raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    const base = display ?? DEFAULT_SIZE
    instance.setDeviceSize({ ...base, [dim]: Math.max(1, n) })
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-muted/30 px-3 text-xs">
      <span className="text-muted-foreground">{intl.formatMessage({ id: "browser.device.dimensions", defaultMessage: "Dimensions:" })}</span>
      <select
        value={activeLabel}
        onChange={(e) => onPreset(e.target.value)}
        className={cn(fieldCls, "min-w-[120px]")}
      >
        {activeLabel === "Custom" ? <option value="Custom">Custom</option> : null}
        {PRESETS.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
      </select>

      <input
        type="number"
        value={display?.width ?? ""}
        placeholder="Auto"
        onChange={(e) => onDim("width", e.target.value)}
        className={cn(fieldCls, "w-16 text-center")}
      />
      <span className="text-muted-foreground">×</span>
      <input
        type="number"
        value={display?.height ?? ""}
        placeholder="Auto"
        onChange={(e) => onDim("height", e.target.value)}
        className={cn(fieldCls, "w-16 text-center")}
      />

      <button
        type="button"
        aria-label={intl.formatMessage({ id: "browser.device.rotate", defaultMessage: "Rotate" })}
        title={intl.formatMessage({ id: "browser.device.rotate", defaultMessage: "Rotate" })}
        disabled={size == null}
        onClick={() => instance.rotateDevice()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>

      <select
        value={String(state.zoom)}
        onChange={(e) => instance.setZoom(Number(e.target.value))}
        className={cn(fieldCls, "ml-1 w-20")}
      >
        {(ZOOMS.includes(state.zoom) ? ZOOMS : [...ZOOMS, state.zoom].sort((a, b) => a - b)).map(
          (z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          )
        )}
      </select>

      <div className="flex-1" />
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "browser.device.close", defaultMessage: "Close device toolbar" })}
        title={intl.formatMessage({ id: "browser.device.close", defaultMessage: "Close device toolbar" })}
        onClick={() => instance.setDeviceToolbar(false)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
