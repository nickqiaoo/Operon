import { useCallback, useState, type ReactNode } from 'react';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { ImageViewer } from '@/components/ai-elements/image-viewer';
import { useAuthedObjectUrl } from '@/hooks/useAuthedObjectUrl';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getImageMediaType } from '@/lib/file-preview';
import { useFileStat, useFileUrl } from '@/lib/fs-queries';
import { cn } from '@/lib/utils';
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
 * A step line (a tool row, a work group's summary) with the images it read:
 * a strip of small thumbnails at the right end on desktop, a gallery under it
 * on a phone. Each image is read again from disk by its path; one that is gone
 * since simply isn't shown.
 */
export function ReadImagesRow({ paths, children }: { paths: string[]; children: ReactNode }) {
  const isMobile = useIsMobile();
  if (paths.length === 0) return <>{children}</>;
  if (isMobile) {
    return (
      <div className="min-w-0">
        {children}
        <ReadImageGallery paths={paths} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-1.5">
        {paths.slice(0, DESKTOP_MAX).map((path) => (
          <ReadImageThumb key={path} path={path} variant="strip" />
        ))}
        {paths.length > DESKTOP_MAX && (
          <span className="text-xs tabular-nums text-muted-foreground/70">+{paths.length - DESKTOP_MAX}</span>
        )}
      </div>
    </div>
  );
}

const DESKTOP_MAX = 4;
/** Phone gallery: rows this tall before stretching to fill the width. */
const ROW_HEIGHT = 110;
const MOBILE_MAX = 6;

/**
 * Justified rows: each image takes width in proportion to its aspect ratio, so
 * a row of a wide and a tall picture fills the width at one height. Until an
 * image loads its ratio is taken as square.
 */
function ReadImageGallery({ paths }: { paths: string[] }) {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const onRatio = useCallback((path: string, ratio: number) => {
    setRatios((prev) => (prev[path] === ratio ? prev : { ...prev, [path]: ratio }));
  }, []);
  const shown = paths.slice(0, MOBILE_MAX);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {shown.map((path) => {
        const ratio = ratios[path] ?? 1;
        return (
          <div
            key={path}
            className="min-w-0"
            style={{ flexGrow: ratio, flexBasis: `${ratio * ROW_HEIGHT}px`, aspectRatio: String(ratio), maxHeight: 260 }}
          >
            <ReadImageThumb path={path} onRatio={onRatio} variant="tile" />
          </div>
        );
      })}
      {paths.length > MOBILE_MAX && (
        <span className="self-end text-xs tabular-nums text-muted-foreground/70">+{paths.length - MOBILE_MAX}</span>
      )}
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
  return <ReadImageThumb path={path} variant="large" />;
}

/** The picture with its file name under it: one cell of a reply's image gallery. */
export function ReadImageFigure({ path }: { path: string }) {
  return <ReadImageThumb path={path} variant="figure" />;
}

function ReadImageThumb({
  path,
  variant,
  onRatio,
}: {
  path: string;
  variant: ThumbVariant;
  onRatio?: (path: string, ratio: number) => void;
}) {
  const { data: stat, isError: statFailed } = useFileStat(path);
  const { data: url = null, isError: urlFailed } = useFileUrl(stat?.isFile ? path : null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The web client's image URLs need the bearer header; desktop's carry the token.
  const authedUrl = useAuthedObjectUrl(__APP_TARGET__ === 'web' ? url : null);
  const src = __APP_TARGET__ === 'web' ? authedUrl : url;
  const name = basename(path);

  if (statFailed || urlFailed || stat?.isFile === false || (src !== null && src === brokenSrc)) return null;
  // A figure takes real room in the thread: a placeholder for a file that turns out
  // to be gone would open a gap and then collapse it.
  if (variant === 'figure' && !stat) return null;

  const thumbnail = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Preview ${name}`}
          title={name}
          className={cn(
            'block cursor-zoom-in overflow-hidden rounded-md border border-border/50 bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
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
                if (w > 0 && h > 0) onRatio?.(path, Math.round((w / h) * 100) / 100);
              }}
              onError={() => setBrokenSrc(src)}
            />
          ) : (
            // Holds the space while the URL resolves, so the row doesn't jump.
            <div className={cn('animate-pulse', PLACEHOLDER_CLASS[variant])} />
          )}
        </button>
      </DialogTrigger>
      {open && src && <ImageViewer src={src} filename={name} />}
    </Dialog>
  );

  if (variant !== 'figure') return thumbnail;
  return (
    <figure className="m-0 min-w-0 md:w-56">
      {thumbnail}
      <figcaption title={path} className="mt-1 truncate text-xs text-muted-foreground">
        {name}
      </figcaption>
    </figure>
  );
}
