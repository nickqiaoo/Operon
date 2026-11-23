import { useMemo } from 'react';
import { extractLocalImagePaths } from '@/lib/reply-images';
import { ReadImageFigure, useShowableImages, type ToolImage } from './ReadImages';

const MAX_IMAGES = 6;

/**
 * The pictures of a finished reply, in a row under its text: what its tool
 * calls read or produced (a Read of an image, a screenshot), then the local
 * images its text mentions — each once. A folded turn hides its steps, so this
 * is where those pictures stay in view. A file that no longer exists drops out:
 * the path is still there in the prose.
 */
export function ReplyImageGallery({ text, toolImages = [] }: { text: string; toolImages?: ToolImage[] }) {
  const all = useMemo(() => {
    const byKey = new Map<string, ToolImage>(toolImages.map((image) => [image.key, image]));
    for (const path of extractLocalImagePaths(text)) {
      const key = `path:${path}`;
      if (!byKey.has(key)) byKey.set(key, { key, path });
    }
    return [...byKey.values()];
  }, [text, toolImages]);
  const images = useShowableImages(all);
  if (images.length === 0) return null;
  return (
    <div data-testid="reply-image-gallery" className="mt-2 grid w-full grid-cols-2 gap-2 empty:hidden md:flex md:flex-wrap">
      {images.slice(0, MAX_IMAGES).map((image) => (
        <ReadImageFigure key={image.key} image={image} />
      ))}
      {images.length > MAX_IMAGES && (
        <span className="self-center text-xs tabular-nums text-muted-foreground/70">+{images.length - MAX_IMAGES}</span>
      )}
    </div>
  );
}
