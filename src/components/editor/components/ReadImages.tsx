import { useCallback, useState, type ReactNode } from 'react';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { ImageViewer, type ImageViewerNav } from '@/components/ai-elements/image-viewer';
import { normalizeToolOutputBlocks } from '@/components/ai-elements/tool';
import { useAuthedObjectUrl } from '@/hooks/useAuthedObjectUrl';
import { useIsMobileShell } from '@/hooks/useIsMobile';
import { getImageMediaType } from '@/lib/file-preview';
import { useFileStat, useFileUrl } from '@/lib/fs-queries';
import { cn } from '@/lib/utils';
import { useFileOpenHandler } from '@/lib/file-open-context';
import { toolNameOf } from './TaskCreatedRenderer';
import { unwrapToolEnvelope, type ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * The image a finished Read call looked at (Claude Code's Read tool on a png,
 * jpg, …), or null for anything else.
 */
export function imageReadPathOf(toolPart: ToolPartLike & { state?: string }): string | null {
  if (toolNameOf(toolPart) !== 'Read') return null;
  if (normalizeToolState(toolPart.state) !== 'output-available') return null;
  const rawName = (toolPart as { toolName?: string }).toolName ?? '';
  const rawInput = ((toolPart as { args?: unknown }).args ?? (toolPart as { input?: unknown }).input ?? {}) as Record<string, unknown>;
  const input = unwrapToolEnvelope(rawName, rawInput).input as Record<string, unknown> | undefined;
  const path = input?.file_path;
  if (typeof path !== 'string' || !path) return null;
  return getImageMediaType(path) ? path : null;
}

/**
 * A picture a tool call produced: a file a Read looked at (read again from disk
 * by its path), or an image the tool returned itself — a screenshot from a
 * browser / computer-use / devtools tool, inline as base64 or a URL.
 */
export type ToolImage =
  | { key: string; path: string; src?: undefined }
  | { key: string; src: string; path?: undefined };

/** A stable short key for an inline image: data URLs share their prefix, so take length + tail. */
function srcKey(src: string): string {
  return `src:${src.length}:${src.slice(-48)}`;
}

/** The images a finished tool call read or returned, in order; [] for anything else. */
export function toolImagesOf(toolPart: ToolPartLike & { state?: string }): ToolImage[] {
  const path = imageReadPathOf(toolPart);
  if (path !== null) return [{ key: `path:${path}`, path }];
  if (normalizeToolState(toolPart.state) !== 'output-available') return [];
  const output = (toolPart as { result?: unknown }).result ?? (toolPart as { output?: unknown }).output;
  const blocks = normalizeToolOutputBlocks(output) ?? [];
  const images: ToolImage[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'image') continue;
    const key = srcKey(block.src);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ key, src: block.src });
  }
  return images;
}

/** The images of several tool calls, each once. */
export function uniqueToolImages(parts: Array<ToolPartLike & { state?: string }>): ToolImage[] {
  const byKey = new Map<string, ToolImage>();
  for (const part of parts) {
    for (const image of toolImagesOf(part)) if (!byKey.has(image.key)) byKey.set(image.key, image);
  }
  return [...byKey.values()];
}

/**
 * A step line (a tool row, a work group's summary) with the images it read:
 * a strip of small thumbnails at the right end on desktop, a gallery under it
 * on a phone. Each image is read again from disk by its path; one that is gone
 * since simply isn't shown.
 */
export function ReadImagesRow({ images: all, children }: { images: ToolImage[]; children: ReactNode }) {
  const isMobile = useIsMobileShell();
  const images = useShowableImages(all);
  if (images.length === 0) return <>{children}</>;
  if (isMobile) {
    return (
      <div className="min-w-0">
        {children}
        <ReadImageGallery images={images} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-1.5">
        {images.slice(0, DESKTOP_MAX).map((image, index) => (
          <ReadImageThumb
            key={image.key}
            image={image}
            variant="strip"
            set={images}
            index={index}
            more={moreAt(images.length, DESKTOP_MAX, index)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Files are read through the host's file access, which some surfaces lack;
 * there only the inline images can show.
 */
export function useShowableImages(images: ToolImage[]): ToolImage[] {
  const openFile = useFileOpenHandler();
  return openFile ? images : images.filter((image) => image.src !== undefined);
}

const DESKTOP_MAX = 4;
/** Phone gallery: rows this tall before stretching to fill the width. */
const ROW_HEIGHT = 110;
const MOBILE_MAX = 6;

/**
 * How many images the cell at `index` stands for beyond itself: the last cell
 * of a capped row covers itself and everything after it ("+N"), so the row never
 * grows past `max` and a tap on it opens the viewer there to step through the rest.
 */
export function moreAt(total: number, max: number, index: number): number {
  return total > max && index === max - 1 ? total - max + 1 : 0;
}

/**
 * Justified rows: each image takes width in proportion to its aspect ratio, so
 * a row of a wide and a tall picture fills the width at one height. Until an
 * image loads its ratio is taken as square.
 */
function ReadImageGallery({ images }: { images: ToolImage[] }) {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const onRatio = useCallback((key: string, ratio: number) => {
    setRatios((prev) => (prev[key] === ratio ? prev : { ...prev, [key]: ratio }));
  }, []);
  const shown = images.slice(0, MOBILE_MAX);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {shown.map((image, index) => {
        const ratio = ratios[image.key] ?? 1;
        return (
          <div
            key={image.key}
            className="min-w-0"
            style={{ flexGrow: ratio, flexBasis: `${ratio * ROW_HEIGHT}px`, aspectRatio: String(ratio), maxHeight: 260 }}
          >
            <ReadImageThumb
              image={image}
              onRatio={onRatio}
              variant="tile"
              set={images}
              index={index}
              more={moreAt(images.length, MOBILE_MAX, index)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * strip: a small thumbnail on a row. tile: fills a gallery cell. large: the
 * picture itself, bounded. figure: a same-sized cell with the file name under it.
 */
type ThumbVariant = 'strip' | 'tile' | 'large' | 'figure';

const BUTTON_CLASS: Record<ThumbVariant, string> = {
  strip: 'h-7 max-w-16',
  tile: 'size-full',
  large: 'max-w-full',
  figure: 'h-32 w-full md:h-36',
};
const IMG_CLASS: Record<ThumbVariant, string> = {
  strip: 'h-full w-auto max-w-full object-cover',
  tile: 'size-full object-cover',
  large: 'max-h-80 max-w-full object-contain',
  figure: 'size-full object-contain',
};
const PLACEHOLDER_CLASS: Record<ThumbVariant, string> = {
  strip: 'h-full w-10',
  tile: 'size-full',
  large: 'h-40 w-56',
  figure: 'size-full',
};

/** The picture itself, bounded: what an opened Read row shows in place of its "[image]" result. */
export function ReadImageLarge({ path }: { path: string }) {
  return <ReadImageThumb image={{ key: `path:${path}`, path }} variant="large" />;
}

/**
 * The picture with its file name under it: one cell of a reply's image gallery.
 * `set` / `index`: the gallery it belongs to, which its viewer steps through.
 */
export function ReadImageFigure({ image, set, index, more }: { image: ToolImage; set?: ToolImage[]; index?: number; more?: number }) {
  return <ReadImageThumb image={image} variant="figure" set={set} index={index} more={more} />;
}

function imageName(image: ToolImage): string {
  return image.path ? basename(image.path) : 'Screenshot';
}

/**
 * Where to load an image from: inline images as they are; files read again from
 * disk by their path. `unavailable`: the file is gone since, or this surface
 * can't read files.
 */
function useToolImageSrc(image: ToolImage) {
  const { path = null } = image;
  const openFile = useFileOpenHandler();
  const { data: stat, isError: statFailed } = useFileStat(openFile && path ? path : null);
  const { data: url = null, isError: urlFailed } = useFileUrl(stat?.isFile && path ? path : null);
  // The web client's image URLs need the bearer header; desktop's carry the token.
  const authedUrl = useAuthedObjectUrl(__APP_TARGET__ === 'web' ? url : null);
  const fileSrc = __APP_TARGET__ === 'web' ? authedUrl : url;
  const unavailable = path !== null && (!openFile || statFailed || urlFailed || stat?.isFile === false);
  return { src: image.src ?? fileSrc, unavailable, statLoaded: stat !== undefined };
}

/** The viewer for one image of a set, stepping through the others with ← / → or a swipe. */
function ToolImageSetViewer({ images, initialIndex }: { images: ToolImage[]; initialIndex: number }) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), images.length - 1));
  const current = images[Math.min(index, images.length - 1)];
  const { src, unavailable } = useToolImageSrc(current);
  const count = images.length;
  const nav: ImageViewerNav | undefined = count > 1
    ? {
        index,
        count,
        onPrev: index > 0 ? () => setIndex((i) => Math.max(0, i - 1)) : undefined,
        onNext: index < count - 1 ? () => setIndex((i) => Math.min(count - 1, i + 1)) : undefined,
      }
    : undefined;
  return <ImageViewer src={src} filename={imageName(current)} unavailable={unavailable} nav={nav} />;
}

function ReadImageThumb({
  image,
  variant,
  onRatio,
  set,
  index = 0,
  more = 0,
}: {
  image: ToolImage;
  variant: ThumbVariant;
  onRatio?: (key: string, ratio: number) => void;
  /** The images this one is shown with: its viewer steps through them. Alone without it. */
  set?: ToolImage[];
  index?: number;
  /** This cell also stands for the images after it: shown as "+N" over the picture. */
  more?: number;
}) {
  const { path = null } = image;
  const { src, unavailable, statLoaded } = useToolImageSrc(image);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const name = imageName(image);

  if (src !== null && src === brokenSrc) return null;
  if (path !== null && unavailable) return null;
  // A figure takes real room in the thread: a placeholder for a file that turns out
  // to be gone would open a gap and then collapse it.
  if (variant === 'figure' && path !== null && !statLoaded) return null;

  const thumbnail = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={more > 0 ? `Preview ${name} and ${more - 1} more` : `Preview ${name}`}
          title={more > 0 ? `${more - 1} more` : name}
          className={cn(
            'relative block cursor-zoom-in overflow-hidden rounded-md border border-border/50 bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            (variant === 'large' || variant === 'figure') && 'rounded-lg',
            BUTTON_CLASS[variant],
          )}
        >
          {src ? (
            <img
              src={src}
              alt={name}
              loading="lazy"
              className={cn('block', IMG_CLASS[variant])}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w > 0 && h > 0) onRatio?.(image.key, Math.round((w / h) * 100) / 100);
              }}
              onError={() => setBrokenSrc(src)}
            />
          ) : (
            // Holds the space while the URL resolves, so the row doesn't jump.
            <div className={cn('animate-pulse', PLACEHOLDER_CLASS[variant])} />
          )}
          {more > 0 && (
            <span
              aria-hidden
              className={cn(
                'absolute inset-0 flex items-center justify-center bg-background/75 font-medium tabular-nums text-foreground backdrop-blur-[2px]',
                variant === 'strip' ? 'text-[10px]' : 'text-base',
              )}
            >
              +{more}
            </span>
          )}
        </button>
      </DialogTrigger>
      {open && <ToolImageSetViewer images={set ?? [image]} initialIndex={set ? index : 0} />}
    </Dialog>
  );

  if (variant !== 'figure') return thumbnail;
  return (
    <figure className="m-0 min-w-0 md:w-56">
      {thumbnail}
      <figcaption title={path ?? name} className="mt-1 truncate text-xs text-muted-foreground">
        {name}
      </figcaption>
    </figure>
  );
}
