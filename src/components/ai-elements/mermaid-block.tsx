import { DownloadIcon, MaximizeIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useResolvedMode } from "@/hooks/useResolvedMode";
import { cn } from "@/lib/utils";

interface Diagram {
  id: string;
  svg: string;
}

let nextId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

function renderMermaid(source: string, dark: boolean, cancelled: () => boolean, forRaster = false) {
  const task = renderQueue.then(async () => {
    if (cancelled()) return;
    const { default: mermaid } = await import("mermaid");
    if (cancelled()) return;
    const id = "operon-mermaid-" + ++nextId;
    // Mermaid configuration is shared; run initialization and rendering together.
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "monospace",
      ...(forRaster ? { htmlLabels: false, flowchart: { htmlLabels: false } } : {}),
    });
    const { svg } = await mermaid.render(id, source);
    return { id, svg };
  });
  renderQueue = task.catch(() => {});
  return task;
}

function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function savePng(code: string, dark: boolean) {
  // SVG foreignObject labels would taint the canvas. Use native SVG labels
  // for the export and keep Mermaid's original labels in the preview.
  const diagram = await renderMermaid(code, dark, () => false, true);
  if (!diagram) return;
  const source = new DOMParser().parseFromString(diagram.svg, "image/svg+xml").documentElement;
  const [, , width, height] = (source.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (!(width > 0 && height > 0)) return;
  const scale = Math.min(2, 4096 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  source.setAttribute("width", String(canvas.width));
  source.setAttribute("height", String(canvas.height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(source)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    canvas.toBlob((file) => { if (file) saveFile(file, "diagram.png"); });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const adjustZoom = (zoom: number, step: number) => Math.min(3, Math.max(0.5, zoom + step));

function DiagramViewport({ svg, expanded, controls }: { svg: string; expanded?: boolean; controls: boolean }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !controls) return;
    const zoomOnPinch = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((value) => adjustZoom(value, event.deltaY < 0 ? 0.1 : -0.1));
    };
    element.addEventListener("wheel", zoomOnPinch, { passive: false });
    return () => element.removeEventListener("wheel", zoomOnPinch);
  }, [controls]);

  function startPan(event: PointerEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (!controls || event.pointerType !== "mouse" || event.button !== 0 ||
        (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) return;
    if (event.target instanceof Element && event.target.closest("a")) return;
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
  }

  function pan(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
    event.currentTarget.scrollTop = start.top + start.y - event.clientY;
  }

  return (
    <div className="relative bg-background">
      <div
        ref={viewport}
        onPointerDown={startPan}
        onPointerMove={pan}
        onLostPointerCapture={() => { drag.current = null; }}
        className={cn("overflow-auto p-4", expanded ? "h-[72dvh]" : "max-h-96", controls && "pb-9", controls && zoom > 1 && "cursor-grab active:cursor-grabbing")}
      >
        <div
          className="mx-auto w-full [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:w-full"
          style={{ width: zoom * 100 + "%" }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {controls && (
        <div className="absolute right-2 bottom-2 flex items-center rounded-md bg-background/90 shadow-sm">
          <Button variant="ghost" size="icon-xs" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((value) => adjustZoom(value, -0.25))}><MinusIcon /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Reset zoom" title="Reset zoom" onClick={() => setZoom(1)}><RotateCcwIcon /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((value) => adjustZoom(value, 0.25))}><PlusIcon /></Button>
        </div>
      )}
    </div>
  );
}

export default function MermaidBlock({ source, incomplete, controls }: { source: string; incomplete: boolean; controls: boolean }) {
  const dark = useResolvedMode() === "dark";
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  // During streaming, an unfinished line may temporarily invalidate an otherwise
  // valid diagram. Render complete lines and keep the previous valid result.
  const completeSource = incomplete ? source.slice(0, source.lastIndexOf("\n") + 1) : source;

  useEffect(() => {
    if (!completeSource.trim()) return;
    let cancelled = false;
    void renderMermaid(completeSource, dark, () => cancelled).then((result) => {
      if (cancelled || !result) return;
      setDiagram(result);
      setFailedSource(null);
    }, () => {
      if (!cancelled && !incomplete) setFailedSource(completeSource);
    });
    return () => { cancelled = true; };
  }, [completeSource, dark, incomplete]);

  const sourceFallback = !incomplete && failedSource === completeSource;
  if (incomplete && !diagram) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-muted" data-mermaid-block>
      <div className="flex h-8 items-center justify-between border-b border-border/50 px-3 font-mono text-xs text-muted-foreground">
        <span>mermaid</span>
        {controls && (
          <div className="-mr-1 flex items-center gap-0.5">
            <CodeBlockCopyButton value={source} disabled={incomplete} title="Copy Mermaid source" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Download diagram" title="Download diagram" disabled={incomplete}><DownloadIcon /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => saveFile(new Blob([source], { type: "text/plain" }), "diagram.mmd")}>Mermaid source</DropdownMenuItem>
                {diagram && !sourceFallback && (
                  <>
                    <DropdownMenuItem onSelect={() => saveFile(new Blob([diagram.svg], { type: "image/svg+xml" }), "diagram.svg")}>SVG</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void savePng(source, dark).catch(() => {})}>PNG</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {diagram && !sourceFallback && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Expand diagram" title="Expand diagram"><MaximizeIcon /></Button>
                </DialogTrigger>
                <DialogContent aria-describedby={undefined} className="w-[calc(100%-2rem)] max-w-none gap-2 sm:max-w-6xl">
                  <DialogTitle>Mermaid diagram</DialogTitle>
                  <DiagramViewport svg={diagram.svg.replaceAll(diagram.id, diagram.id + "-expanded")} expanded controls />
                </DialogContent>
              </Dialog>
            )}
          </div>
        )}
      </div>
      {sourceFallback
        ? <pre className="m-0"><code>{source}</code></pre>
        : diagram && <DiagramViewport svg={diagram.svg} controls={controls} />}
    </div>
  );
}
