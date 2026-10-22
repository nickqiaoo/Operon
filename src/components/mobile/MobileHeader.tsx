import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { MobileSheet } from "./MobileSheet"
import { hasNativeTabBar, nativeTopBarTakesSpace } from "@/lib/native"

/** One of a page's own header actions. `symbol` is its SF Symbol in the native iOS bar. */
export interface MobileHeaderAction {
  id: string
  label: string
  icon: ReactNode
  symbol: string
  onClick: () => void
}

/** A segmented switch in place of the context switcher (the Board's Tasks | Channels). */
export interface MobileHeaderSegments {
  items: { id: string; label: string }[]
  selected: string
  onSelect: (id: string) => void
}

/**
 * A pull-down's contents: choices (`selected` set, ticked when true), commands
 * (`selected` left out: never ticked) and groups of them —
 * listed in place (`inline`, a titled section) or behind a row of their own (a
 * submenu, `detail` naming the current choice). Ids come back through `onSelect`.
 */
export type MobileMenuNode =
  | { kind: "item"; id: string; label: string; selected?: boolean }
  | { kind: "group"; id: string; label: string; inline?: boolean; detail?: string; children: MobileMenuNode[] }

/** A pull-down in the header: a system menu in the iOS bar, a sheet elsewhere. */
export interface MobileHeaderMenu {
  label: string
  icon: ReactNode
  /** SF Symbol for the native bar. */
  symbol: string
  nodes: MobileMenuNode[]
  onSelect: (id: string) => void
}

/**
 * What a list screen's one top row holds. Leading: the project › workspace
 * switcher, or `segments`. Trailing: a `menu`, the page's `actions`, then the
 * inbox bell, which every header has.
 */
export interface MobileHeaderSpec {
  segments?: MobileHeaderSegments
  menu?: MobileHeaderMenu
  actions?: MobileHeaderAction[]
}

/**
 * What the shell ({@link MobileApp}) hands every page's header: where the status
 * bar ends, the current project/workspace and how to switch it, the Board tab's
 * project filter, the inbox bell — and, where the native bar draws the row
 * (`native`), the way to hand it this page's spec.
 */
export interface MobileHeaderShell {
  /** Top padding that clears the status bar (and the native bar, when it is up). */
  topInset: string
  projectName: string | null
  workspaceName: string | null
  openContext: () => void
  bell: ReactNode
  /** The native bar draws the header row (iOS), floating over the page. */
  native: boolean
  /** That bar's height, below the status bar. */
  barHeight: number
  /** The floating tab bar's height while it floats over the page (iOS), else 0. */
  tabBarOverlay: number
  publishHeader: (owner: object, spec: MobileHeaderSpec) => void
  clearHeader: (owner: object) => void
}

export const MobileHeaderContext = createContext<MobileHeaderShell | null>(null)

const FALLBACK_INSET = "env(safe-area-inset-top)"

/** For pages that draw their own top row (a pushed page, a full-screen conversation). */
export function useMobileTopInset(): string {
  return useContext(MobileHeaderContext)?.topInset ?? FALLBACK_INSET
}

/**
 * Bottom padding for a list screen's scrolling content. The iOS tab bar floats
 * over the page, so the list runs under its glass and pads only its last row
 * clear of it; elsewhere the shell already stops the page above the bar.
 */
export function useMobileContentBottom(): string {
  return `${useContext(MobileHeaderContext)?.tabBarOverlay ?? 0}px`
}

/**
 * Top padding for a full-screen page opened over a conversation, where the
 * native bar is a lone back button: iOS floats it (clear the status bar and the
 * bar), Android's bar already took its space, a browser has only the status bar.
 */
export function useMobileBackBarOffset(): string {
  const shell = useContext(MobileHeaderContext)
  if (!hasNativeTabBar()) return FALLBACK_INSET
  if (nativeTopBarTakesSpace()) return "0px"
  return `calc(${FALLBACK_INSET} + ${shell?.barHeight ?? 44}px)`
}

/**
 * Top padding for a list screen's scrolling content. Where the native bar draws
 * the header it floats over the page, so the content starts below it and
 * scrolls underneath; where MobileHeader draws the row it takes its own space
 * and nothing extra is needed.
 */
export function useMobileContentOffset(): string {
  const shell = useContext(MobileHeaderContext)
  // Android's bar takes its space out of the web view instead of floating.
  return shell?.native && !nativeTopBarTakesSpace() ? `calc(${shell.topInset} + ${shell.barHeight}px)` : "0px"
}

/**
 * The one row at the top of a phone list screen: context on the left, the
 * page's own actions and the inbox bell on the right, no page title (the tab bar
 * already says where you are). In the apps the native bar draws it from the
 * spec (floating on iOS, above the web view on Android); in a browser it is drawn here.
 */
export function MobileHeader(spec: MobileHeaderSpec) {
  const shell = useContext(MobileHeaderContext)
  const native = shell?.native ?? false
  const owner = useRef({}).current
  const publishHeader = shell?.publishHeader
  const clearHeader = shell?.clearHeader

  // Re-published every render so the native bar's taps reach this render's
  // callbacks; the shell only redraws the bar when what it shows changes.
  useEffect(() => {
    if (native) publishHeader?.(owner, spec)
  })
  useEffect(() => {
    if (!native) return
    return () => clearHeader?.(owner)
  }, [native, clearHeader, owner])

  // Android's native bar sits above the web view: nothing to draw or reserve.
  if (native && nativeTopBarTakesSpace()) return null
  // iOS: the bar floats over the content, which scrolls under it. Web content
  // gets no system scroll-edge blur, so fade it out under the status bar and the
  // bar's glass items, as an open chat does.
  if (native) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-20"
        style={{
          height: `calc(${shell?.topInset ?? FALLBACK_INSET} + ${shell?.barHeight ?? 44}px)`,
          background:
            "linear-gradient(to bottom, color-mix(in srgb, var(--color-background) 88%, transparent) 0%, color-mix(in srgb, var(--color-background) 60%, transparent) 55%, transparent 100%)",
        }}
      />
    )
  }

  return (
    <header className="shrink-0 border-b border-border/40 bg-background" style={{ paddingTop: shell?.topInset ?? FALLBACK_INSET }}>
      <div className="flex h-12 items-center gap-1 pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center">
          {spec.segments ? <Segments {...spec.segments} /> : <MobileContextChip />}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {spec.menu && <MenuButton {...spec.menu} />}
          {spec.actions?.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={action.onClick}
              aria-label={action.label}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground active:bg-row-hover"
            >
              {action.icon}
            </button>
          ))}
          {shell?.bell}
        </div>
      </div>
    </header>
  )
}

function Segments({ items, selected, onSelect }: MobileHeaderSegments) {
  return (
    <div className="flex shrink-0 items-center rounded-lg border border-border/40 bg-muted/25 p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={cn(
            "flex h-8 items-center rounded-md px-3 text-[14px] font-medium transition-colors",
            selected === item.id ? "bg-popover/90 text-foreground shadow-card" : "text-muted-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** `project › workspace ▾`, left-aligned and only as wide as its text. */
function MobileContextChip() {
  const shell = useContext(MobileHeaderContext)
  return (
    <button
      type="button"
      onClick={shell?.openContext}
      className="flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 text-left active:bg-row-hover"
    >
      <span className="truncate text-[15px] font-semibold text-foreground/90">{shell?.projectName ?? "operon"}</span>
      {shell?.workspaceName && (
        <>
          <span className="shrink-0 text-muted-foreground/40">›</span>
          <span className="min-w-0 truncate text-[14px] text-muted-foreground">{shell.workspaceName}</span>
        </>
      )}
      <ChevronDown className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  )
}

/** Off the iOS bar the menu is a sheet: sections for the groups, a tick on each choice. */
function MenuButton({ label, icon, nodes, onSelect }: MobileHeaderMenu) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className="flex size-9 items-center justify-center rounded-lg text-muted-foreground active:bg-row-hover"
      >
        {icon}
      </button>
      <MobileSheet open={open} onClose={() => setOpen(false)} title={label}>
        <MenuNodes
          nodes={nodes}
          onSelect={(id) => {
            setOpen(false)
            onSelect(id)
          }}
        />
      </MobileSheet>
    </>
  )
}

function MenuNodes({ nodes, onSelect }: { nodes: MobileMenuNode[]; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-3 pb-2">
      {nodes.map((node) =>
        node.kind === "item" ? (
          <MenuRow key={node.id} label={node.label} selected={node.selected} onClick={() => onSelect(node.id)} />
        ) : (
          <div key={node.id}>
            <div className="px-3 pb-1 text-[13px] font-medium text-muted-foreground/80">{node.label}</div>
            <div className="space-y-0.5">
              {node.children.map((child) =>
                child.kind === "item" ? (
                  <MenuRow key={child.id} label={child.label} selected={child.selected} onClick={() => onSelect(child.id)} />
                ) : (
                  <MenuNodes key={child.id} nodes={[child]} onSelect={onSelect} />
                ),
              )}
            </div>
          </div>
        ),
      )}
    </div>
  )
}

function MenuRow({ label, selected, onClick }: { label: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-base",
        selected ? "bg-row-selected text-foreground" : "text-foreground/85 active:bg-row-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check className="size-4 shrink-0 text-brand" />}
    </button>
  )
}
