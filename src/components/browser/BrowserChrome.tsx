import { useEffect, useRef, useState, type FormEvent } from "react"
import { useIntl } from "react-intl"
import { toast } from "sonner"
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  MessageSquarePlus,
  Minus,
  MonitorSmartphone,
  MoreVertical,
  Plus,
  RotateCcw,
  RotateCw,
  ScanLine,
  Send,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type WebviewInstance,
  type WebviewState,
} from "./WebviewInstance"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAnnotationsStore, annotationsForInstance } from "@/stores/annotations-store"
import { useAnnotationSendStore } from "@/stores/annotation-send-store"
import { useEditorStore } from "@/stores/editor-store"

interface BrowserChromeProps {
  instance: WebviewInstance
  className?: string
}

const normalizeUrl = (input: string): string => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return ""
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("about:"))
    return trimmed
  // Anything with a space → treat as search query.
  if (/\s/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
  // Looks like a bare host → assume https.
  return `https://${trimmed}`
}

/** Compact navigation bar: back / forward / reload / URL input. */
export function BrowserChrome({ instance, className }: BrowserChromeProps) {
  const intl = useIntl()
  const [state, setState] = useState<WebviewState>(() => instance.getState())
  const [draft, setDraft] = useState(state.url)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const annotationCount = useAnnotationsStore(
    (s) => annotationsForInstance(s.items, instance.instanceId).length
  )
  const requestSend = useAnnotationSendStore((s) => s.requestSend)

  useEffect(() => {
    setState(instance.getState())
    setDraft(instance.getState().url)
    return instance.subscribe((next) => {
      setState(next)
      if (document.activeElement !== inputRef.current) {
        setDraft(next.url)
      }
    })
  }, [instance])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const url = normalizeUrl(draft)
    if (url.length === 0) return
    instance.navigate(url)
    inputRef.current?.blur()
  }

  return (
    <div
      className={cn(
        // Same rule as TabBar/EditorTabs: canvas colour, border does the dividing.
        "flex h-10 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2",
        className
      )}
    >
      <NavButton
        ariaLabel={intl.formatMessage({ id: "browser.back", defaultMessage: "Back" })}
        disabled={!state.canGoBack}
        onClick={() => instance.back()}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton
        ariaLabel={intl.formatMessage({ id: "browser.forward", defaultMessage: "Forward" })}
        disabled={!state.canGoForward}
        onClick={() => instance.forward()}
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton
        ariaLabel={state.isLoading ? intl.formatMessage({ id: "browser.stop", defaultMessage: "Stop" }) : intl.formatMessage({ id: "browser.reload", defaultMessage: "Reload" })}
        onClick={() => (state.isLoading ? instance.stop() : instance.reload())}
      >
        {state.isLoading ? (
          <X className="h-3.5 w-3.5" />
        ) : (
          <RotateCw className="h-3.5 w-3.5" />
        )}
      </NavButton>
      <form onSubmit={handleSubmit} className="ml-1 flex-1">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          className="h-6 w-full rounded-md border border-border/50 bg-background px-2 text-xs text-foreground outline-none focus:border-border"
          placeholder="https://…"
        />
      </form>
      {state.commentMode && annotationCount > 0 ? (
        <>
          <NavButton
            ariaLabel={state.designPreviewAll ? intl.formatMessage({ id: "browser.showOriginal", defaultMessage: "Show original" }) : intl.formatMessage({ id: "browser.showChanges", defaultMessage: "Show changes" })}
            active={state.designPreviewAll}
            onClick={() => instance.setDesignPreviewAll(!state.designPreviewAll)}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </NavButton>
          <NavButton
            ariaLabel={intl.formatMessage({ id: "browser.clearAnnotations", defaultMessage: "Clear all annotations" })}
            onClick={() => useAnnotationsStore.getState().clearInstance(instance.instanceId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </NavButton>
          <NavButton
            ariaLabel={intl.formatMessage({ id: "browser.sendAnnotations", defaultMessage: "Send annotations to chat" })}
            className="w-auto px-1.5"
            onClick={() => requestSend(useEditorStore.getState().currentWorkspaceId)}
          >
            <span className="flex items-center gap-1">
              <Send className="h-3.5 w-3.5" />
              <span className="text-[11px] font-medium tabular-nums">{annotationCount}</span>
            </span>
          </NavButton>
        </>
      ) : null}
      <NavButton
        ariaLabel={intl.formatMessage({ id: "browser.screenshot", defaultMessage: "Capture screenshot to clipboard" })}
        onClick={async () => {
          const ok = await instance.screenshotToClipboard()
          toast[ok ? "success" : "error"](
            ok ? intl.formatMessage({ id: "browser.screenshotSuccess", defaultMessage: "Screenshot saved to clipboard" }) : intl.formatMessage({ id: "browser.screenshotFailed", defaultMessage: "Screenshot failed" })
          )
        }}
      >
        <ScanLine className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton
        ariaLabel={state.commentMode ? intl.formatMessage({ id: "browser.exitCommentMode", defaultMessage: "Exit comment mode" }) : intl.formatMessage({ id: "browser.addComment", defaultMessage: "Add a comment" })}
        active={state.commentMode}
        onClick={() => instance.setCommentMode(!state.commentMode)}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </NavButton>
      <BrowserMenu instance={instance} state={state} />
    </div>
  )
}

/** The 3-dot browser menu: reload, device toolbar, zoom, clear data. */
function BrowserMenu({ instance, state }: { instance: WebviewInstance; state: WebviewState }) {
  const intl = useIntl()
  const zoomPct = Math.round(state.zoom * 100)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "browser.menu", defaultMessage: "Browser menu" })}
          title={intl.formatMessage({ id: "browser.menu", defaultMessage: "Browser menu" })}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => instance.forceReload()}>
          <RotateCw className="h-3.5 w-3.5" />
          {intl.formatMessage({ id: "browser.forceReload", defaultMessage: "Force reload" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => instance.setDeviceToolbar(!state.deviceToolbar)}>
          <MonitorSmartphone className="h-3.5 w-3.5" />
          {state.deviceToolbar ? intl.formatMessage({ id: "browser.hideDeviceToolbar", defaultMessage: "Hide device toolbar" }) : intl.formatMessage({ id: "browser.showDeviceToolbar", defaultMessage: "Show device toolbar" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Zoom row — kept open while adjusting (onSelect preventDefault). */}
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
          <span>{intl.formatMessage({ id: "browser.zoom", defaultMessage: "Zoom" })}</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "browser.zoomOut", defaultMessage: "Zoom out" })}
              onClick={() => instance.setZoom(state.zoom - 0.1)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-11 text-center text-xs tabular-nums">{zoomPct}%</span>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "browser.zoomIn", defaultMessage: "Zoom in" })}
              onClick={() => instance.setZoom(state.zoom + 0.1)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "browser.resetZoom", defaultMessage: "Reset zoom" })}
              onClick={() => instance.setZoom(1)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await instance.clearData(["cookies"])
            toast.success(intl.formatMessage({ id: "browser.cookiesCleared", defaultMessage: "Browser cookies cleared" }))
          }}
        >
          {intl.formatMessage({ id: "browser.clearCookies", defaultMessage: "Clear browser cookies" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await instance.clearData(["cache"])
            toast.success(intl.formatMessage({ id: "browser.cacheCleared", defaultMessage: "Browser cache cleared" }))
          }}
        >
          {intl.formatMessage({ id: "browser.clearCache", defaultMessage: "Clear browser cache" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface NavButtonProps {
  ariaLabel: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
}

function NavButton({ ariaLabel, disabled, active, onClick, children, className }: NavButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        className,
        active
          ? "bg-primary/15 text-primary hover:bg-primary/25"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      )}
    >
      {children}
    </button>
  )
}
