"use client";

import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { copyImageToClipboard } from "@/lib/copy-image";
import { CheckIcon, CopyIcon, ImageIcon, Loader2Icon, MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type View = { scale: number; x: number; y: number };
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

type ImageViewerProps = { src: string; filename?: string };

function ImageViewerContent({ src, filename }: ImageViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const fitMode = useRef(true);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");

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

  const constrain = useCallback((next: View): View => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return next;
    const maxX = Math.max(0, (image.naturalWidth * next.scale - viewport.clientWidth + 48) / 2);
    const maxY = Math.max(0, (image.naturalHeight * next.scale - viewport.clientHeight + 48) / 2);
    return { ...next, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image?.naturalWidth) return;
    fitMode.current = true;
    const scale = Math.min(
      (viewport.clientWidth - 48) / image.naturalWidth,
      (viewport.clientHeight - 48) / image.naturalHeight,
      MAX_SCALE,
    );
    setView({ scale: Math.max(MIN_SCALE, scale), x: 0, y: 0 });
  }, []);

  const zoom = useCallback((factor: number, point?: { x: number; y: number }) => {
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

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
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
      }}
    >
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
        <Button
          aria-label={copyState === "copied" ? "Image copied" : "Copy image"}
          title="Copy image (⌘C / Ctrl+C)"
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          disabled={!ready || copyState === "copying"}
          onClick={() => void copyImage()}
        >
          {copyState === "copied" ? <CheckIcon /> : copyState === "copying" ? <Loader2Icon className="animate-spin" /> : <CopyIcon />}
        </Button>
        <span className="sr-only" role="status">{copyState === "copied" ? "Image copied to clipboard" : ""}</span>
        <DialogClose asChild>
          <Button aria-label="Close image preview" title="Close (Esc)" type="button" variant="ghost" size="icon" className="rounded-full">
            <XIcon />
          </Button>
        </DialogClose>
      </header>

      <div
        ref={viewportRef}
        aria-label="Image canvas"
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-muted/35",
          ready && (dragging ? "cursor-grabbing" : "cursor-grab"),
        )}
        onDoubleClick={() => {
          if (!ready) return;
          if (fitMode.current) zoom(2);
          else fit();
        }}
        onPointerDown={(event) => {
          if (!ready || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (!previous || previous.pointerId !== event.pointerId) return;
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setView((current) => constrain({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
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
          className="pointer-events-none absolute top-1/2 left-1/2 max-w-none rounded-sm shadow-card"
          style={{
            width: dimensions?.width,
            height: dimensions?.height,
            visibility: ready ? "visible" : "hidden",
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
          onLoad={(event) => {
            setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
            setFailed(false);
            fit();
          }}
          onError={() => setFailed(true)}
        />
      </div>

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
  return (
    <DialogContent
      aria-describedby={undefined}
      className="block h-[94dvh] w-[96vw] max-w-none overflow-hidden rounded-2xl border-border/40 bg-background p-0 shadow-modal sm:max-w-none"
      overlayClassName="bg-background/65 backdrop-blur-md"
      showCloseButton={false}
    >
      <ImageViewerContent key={props.src} {...props} />
    </DialogContent>
  );
}
