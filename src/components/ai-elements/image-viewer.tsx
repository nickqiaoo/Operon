"use client";

import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { copyImageToClipboard } from "@/lib/copy-image";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNativeShellOverlay } from "@/hooks/useNativeShellOverlay";
import { CheckIcon, CopyIcon, ImageIcon, Loader2Icon, MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
/** A touch that moves less than this is a tap. */
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 280;
/** Phone: how far down, or how fast (px/ms), a drag must go to close the viewer. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.6;
/** Phone: double tap zooms to this multiple of the fitted size. */
const DOUBLE_TAP_ZOOM = 2.5;

/**
 * - `pending`: one pointer down, not yet past the tap slop (a tap, or the start of a drag).
 * - `pan`: moving a zoomed image (desktop: any drag).
 * - `dismiss`: phone, image at fit size, dragging vertically to close.
 * - `pinch`: two pointers; zooms around their midpoint and pans with it.
 */
type Gesture =
  | { kind: "pending"; start: Point }
  | { kind: "pan"; last: Point }
  | { kind: "dismiss"; start: Point; lastY: number; lastTime: number; velocity: number }
  | { kind: "pinch"; distance: number; mid: Point };

type ImageViewerProps = { src: string; filename?: string };

function ImageViewerContent({ src, filename, mobile }: ImageViewerProps & { mobile: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fitMode = useRef(true);
  const fitScale = useRef(1);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastPointerType = useRef("mouse");
  const lastTap = useRef<(Point & { time: number }) | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [gestureActive, setGestureActive] = useState(false);
  const [dismissY, setDismissY] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  // Phones show the image edge to edge; the desktop dialog keeps a margin around it.
  const padding = mobile ? 0 : 48;

  const copyImage = async () => {
    if (copyState !== "idle") return;
    setCopyState("copying");
    try {
      await copyImageToClipboard(src);
      setCopyState("copied");
    } catch {
      setCopyState("idle");
      toast.error("Unable to copy image to clipboard");
    }
  };

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const constrain = useCallback((next: View): View => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return next;
    const maxX = Math.max(0, (image.naturalWidth * next.scale - viewport.clientWidth + padding) / 2);
    const maxY = Math.max(0, (image.naturalHeight * next.scale - viewport.clientHeight + padding) / 2);
    return { ...next, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  }, [padding]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image?.naturalWidth) return;
    fitMode.current = true;
    const scale = Math.max(MIN_SCALE, Math.min(
      (viewport.clientWidth - padding) / image.naturalWidth,
      (viewport.clientHeight - padding) / image.naturalHeight,
      MAX_SCALE,
    ));
    fitScale.current = scale;
    setView({ scale, x: 0, y: 0 });
  }, [padding]);

  const zoom = useCallback((factor: number, point?: Point) => {
    fitMode.current = false;
    setView((current) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor));
      const ratio = scale / current.scale;
      return constrain({
        scale,
        x: point ? point.x - (point.x - current.x) * ratio : current.x * ratio,
        y: point ? point.y - (point.y - current.y) * ratio : current.y * ratio,
      });
    });
  }, [constrain]);

  const actualSize = () => {
    fitMode.current = false;
    setView({ scale: 1, x: 0, y: 0 });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (fitMode.current) fit();
      else setView((current) => constrain(current));
    });
    observer.observe(viewport);
    // A non-passive listener prevents wheel / trackpad zoom from scrolling the
    // conversation or zooming the entire Electron window behind the dialog.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.008), {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("wheel", onWheel);
    };
  }, [constrain, fit, zoom]);

  const ready = dimensions !== null && !failed;
  const zoomedIn = () => viewRef.current.scale > fitScale.current * 1.01;

  /** Client coordinates → offset from the viewport's center, the space `view` lives in. */
  const centered = (point: Point): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return point;
    return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
  };

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  /** Pinching below the fitted size springs back once the fingers lift. */
  const settle = () => {
    if (viewRef.current.scale < fitScale.current) fit();
  };

  const handleTap = (point: Point, time: number) => {
    const previous = lastTap.current;
    if (previous && time - previous.time < DOUBLE_TAP_MS && Math.hypot(point.x - previous.x, point.y - previous.y) < 40) {
      lastTap.current = null;
      window.clearTimeout(tapTimer.current);
      if (zoomedIn()) fit();
      else zoom((fitScale.current * DOUBLE_TAP_ZOOM) / viewRef.current.scale, centered(point));
      return;
    }
    lastTap.current = { ...point, time };
    // Wait out a possible second tap before toggling the controls.
    if (mobile) tapTimer.current = window.setTimeout(() => setChromeVisible((visible) => !visible), DOUBLE_TAP_MS);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerType.current = event.pointerType;
    if (!ready || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      fitMode.current = false;
      setDismissY(0);
      gesture.current = { kind: "pinch", ...pinchState() };
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: "pending", start: point };
    }
    setGestureActive(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    let current = gesture.current;
    if (!current) return;

    if (current.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const next = pinchState();
      const factor = next.distance / current.distance;
      const previousMid = centered(current.mid);
      const mid = centered(next.mid);
      gesture.current = { kind: "pinch", ...next };
      const minScale = mobile ? fitScale.current * 0.5 : MIN_SCALE;
      setView((view) => {
        const scale = Math.max(minScale, Math.min(MAX_SCALE, view.scale * factor));
        const ratio = scale / view.scale;
        return constrain({ scale, x: mid.x - (previousMid.x - view.x) * ratio, y: mid.y - (previousMid.y - view.y) * ratio });
      });
      return;
    }

    if (current.kind === "pending") {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      if (mobile && !zoomedIn() && Math.abs(dy) > Math.abs(dx)) {
        gesture.current = { kind: "dismiss", start: current.start, lastY: point.y, lastTime: event.timeStamp, velocity: 0 };
        setDismissY(dy);
        return;
      }
      current = { kind: "pan", last: current.start };
      gesture.current = current;
    }

    if (current.kind === "dismiss") {
      const elapsed = Math.max(1, event.timeStamp - current.lastTime);
      gesture.current = { ...current, lastY: point.y, lastTime: event.timeStamp, velocity: (point.y - current.lastY) / elapsed };
      setDismissY(point.y - current.start.y);
      return;
    }

    const dx = point.x - current.last.x;
    const dy = point.y - current.last.y;
    gesture.current = { kind: "pan", last: point };
    setView((view) => constrain({ ...view, x: view.x + dx, y: view.y + dy }));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = gesture.current;

    // One finger of a pinch lifted: keep panning with the other, from where it is now.
    if (current?.kind === "pinch" && pointers.current.size === 1) {
      const [remaining] = pointers.current.values();
      gesture.current = { kind: "pan", last: remaining };
      return;
    }
    if (pointers.current.size > 0) return;

    gesture.current = null;
    setGestureActive(false);
    if (current?.kind === "dismiss") {
      const dy = event.clientY - current.start.y;
      if (!cancelled && (dy > DISMISS_DISTANCE || current.velocity > DISMISS_VELOCITY)) closeRef.current?.click();
      else setDismissY(0);
      return;
    }
    if (current?.kind === "pending" && !cancelled && event.pointerType !== "mouse") {
      handleTap({ x: event.clientX, y: event.clientY }, event.timeStamp);
    }
    if (mobile || current?.kind === "pinch") settle();
  };

  // Dragging down to close: the image follows and shrinks a little, the backdrop fades.
  const dismissProgress = Math.min(1, Math.max(0, dismissY) / 300);
  const showChrome = chromeVisible && dismissY === 0;

  const copyProps = {
    "aria-label": copyState === "copied" ? "Image copied" : "Copy image",
    title: "Copy image (⌘C / Ctrl+C)",
    type: "button" as const,
    disabled: !ready || copyState === "copying",
    onClick: () => void copyImage(),
  };
  const copyIcon = (className?: string) => copyState === "copied"
    ? <CheckIcon className={className} />
    : copyState === "copying"
      ? <Loader2Icon className={cn("animate-spin", className)} />
      : <CopyIcon className={className} />;
  const copyStatus = <span className="sr-only" role="status">{copyState === "copied" ? "Image copied to clipboard" : ""}</span>;

  const canvas = (
    <div
      ref={viewportRef}
      aria-label="Image canvas"
      className={cn(
        "relative min-h-0 touch-none select-none overflow-hidden",
        mobile ? "absolute inset-0" : "flex-1 bg-muted/35",
        !mobile && ready && (gestureActive ? "cursor-grabbing" : "cursor-grab"),
      )}
      onDoubleClick={(event) => {
        // Touch double taps are recognised in `handleTap`.
        if (!ready || lastPointerType.current !== "mouse") return;
        if (fitMode.current) zoom(2, centered({ x: event.clientX, y: event.clientY }));
        else fit();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endPointer(event, false)}
      onPointerCancel={(event) => endPointer(event, true)}
      onLostPointerCapture={(event) => endPointer(event, true)}
    >
      {!ready && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {failed ? "Unable to load image" : "Loading image…"}
        </div>
      )}
      <img
        ref={imageRef}
        alt={filename || "Image preview"}
        src={src}
        draggable={false}
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 max-w-none",
          mobile ? "will-change-transform" : "rounded-sm shadow-card",
          // Spring back after a cancelled dismiss / double tap; follow the fingers 1:1 otherwise.
          mobile && !gestureActive && "transition-transform duration-200 ease-out",
        )}
        style={{
          width: dimensions?.width,
          height: dimensions?.height,
          visibility: ready ? "visible" : "hidden",
          transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y + dismissY}px) scale(${view.scale * (1 - dismissProgress * 0.2)})`,
        }}
        onLoad={(event) => {
          setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
          setFailed(false);
          fit();
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (ready && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      event.preventDefault();
      void copyImage();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !ready) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoom(0.8); }
    else if (event.key === "0") { event.preventDefault(); fit(); }
    else if (event.key === "1") { event.preventDefault(); actualSize(); }
  };

  if (mobile) {
    const chromeButton = cn(
      "liquid-glass flex size-11 items-center justify-center rounded-full text-foreground/80 transition-[opacity,transform] duration-200 active:scale-[0.94] disabled:opacity-50",
      !showChrome && "pointer-events-none opacity-0 disabled:opacity-0",
    );
    return (
      <div className="relative h-full" onKeyDown={onKeyDown}>
        <div aria-hidden className="absolute inset-0 bg-background" style={{ opacity: 1 - dismissProgress }} />
        <DialogTitle className="sr-only">{filename || "Image preview"}</DialogTitle>
        {canvas}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)] [&>*]:pointer-events-auto">
          <DialogClose asChild>
            <button ref={closeRef} aria-label="Close image preview" type="button" className={chromeButton}>
              <XIcon className="size-5" />
            </button>
          </DialogClose>
          <button {...copyProps} className={chromeButton}>{copyIcon("size-5")}</button>
        </div>
        {copyStatus}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3 sm:px-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground">
          <ImageIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-sm font-medium">{filename || "Image preview"}</DialogTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {dimensions ? `${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} px` : "Image preview"}
          </p>
        </div>
        <Button {...copyProps} variant="ghost" size="icon" className="rounded-full">
          {copyIcon()}
        </Button>
        {copyStatus}
        <DialogClose asChild>
          <Button aria-label="Close image preview" title="Close (Esc)" type="button" variant="ghost" size="icon" className="rounded-full">
            <XIcon />
          </Button>
        </DialogClose>
      </header>

      {canvas}

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-border/40 px-3 py-3 sm:justify-between sm:px-5">
        <p className="hidden text-xs text-muted-foreground sm:block">Scroll to zoom · Drag to pan · Double-click to toggle zoom</p>
        <div className="flex items-center gap-1" role="group" aria-label="Image zoom controls">
          <Button aria-label="Zoom out" title="Zoom out (−)" variant="ghost" size="icon-sm" type="button" disabled={!ready || view.scale <= MIN_SCALE} onClick={() => zoom(0.8)}><MinusIcon /></Button>
          <span aria-live="polite" aria-atomic="true" className="w-14 text-center text-xs tabular-nums text-muted-foreground">{Math.round(view.scale * 100)}%</span>
          <Button aria-label="Zoom in" title="Zoom in (+)" variant="ghost" size="icon-sm" type="button" disabled={!ready || view.scale >= MAX_SCALE} onClick={() => zoom(1.25)}><PlusIcon /></Button>
          <span className="mx-2 h-4 w-px bg-border/60" />
          <Button title="Actual size (1)" variant="ghost" size="sm" type="button" disabled={!ready} onClick={actualSize}>100%</Button>
          <Button title="Fit to window (0)" variant="secondary" size="sm" type="button" disabled={!ready} onClick={fit}><MaximizeIcon />Fit</Button>
        </div>
      </footer>
    </div>
  );
}

/** Shared by composer attachments and images already in the conversation. */
export function ImageViewer(props: ImageViewerProps) {
  const mobile = useIsMobile();
  // Callers mount this only while open. In the packaged apps the native composer, tab bar,
  // scroll button and (for the phone's full-screen layout) top bar sit above the web view,
  // so they must step aside.
  useNativeShellOverlay(true, { fullscreen: mobile });
  return (
    <DialogContent
      aria-describedby={undefined}
      className={cn(
        "block max-w-none overflow-hidden p-0 sm:max-w-none",
        mobile
          ? "inset-0 h-full w-full translate-x-0 translate-y-0 rounded-none border-0 bg-transparent shadow-none dark:border-0"
          : "h-[94dvh] w-[96vw] rounded-2xl border-border/40 bg-background shadow-modal",
      )}
      // Phone: the viewer paints its own backdrop, which fades while dragging down to close.
      overlayClassName={mobile ? "bg-transparent" : "bg-background/65 backdrop-blur-md"}
      showCloseButton={false}
    >
      <ImageViewerContent key={props.src} {...props} mobile={mobile} />
    </DialogContent>
  );
}
