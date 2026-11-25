import { useMemo } from 'react';
import { extractLocalImagePaths } from '@/lib/reply-images';
import { moreAt, ReadImageFigure, useShowableImages, type ToolImage } from './ReadImages';

const MAX_IMAGES = 6;

/**
 * The pictures of a finished reply, in a row under its text: what its tool
 * calls read or produced (a Read of an image, a screenshot), then the local
 * images its text mentions — each once. A folded turn hides its steps, so this
 * is where those pictures stay in view. A file that no longer exists drops out:
 * the path is still there in the prose. Past six, the sixth cell reads "+N" and
 * opens the viewer there, which steps through all of them.
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
      {images.slice(0, MAX_IMAGES).map((image, index) => (
        <ReadImageFigure key={image.key} image={image} set={images} index={index} more={moreAt(images.length, MAX_IMAGES, index)} />
      ))}
    </div>
  );
}
