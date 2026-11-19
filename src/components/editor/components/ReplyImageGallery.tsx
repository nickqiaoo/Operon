import { useMemo } from 'react';
import { extractLocalImagePaths } from '@/lib/reply-images';
import { useFileOpenHandler } from '@/lib/file-open-context';
import { ReadImageFigure } from './ReadImages';

const MAX_IMAGES = 6;

/**
 * The local images a finished reply mentions, in a row under its text. A file
 * that no longer exists drops out: the path is still there in the prose.
 */
export function ReplyImageGallery({ text }: { text: string }) {
  const openFile = useFileOpenHandler();
  const paths = useMemo(() => extractLocalImagePaths(text), [text]);
  if (!openFile || paths.length === 0) return null;
  return (
    <div data-testid="reply-image-gallery" className="mt-2 grid w-full grid-cols-2 gap-2 empty:hidden md:flex md:flex-wrap">
      {paths.slice(0, MAX_IMAGES).map((path) => (
        <ReadImageFigure key={path} path={path} />
      ))}
      {paths.length > MAX_IMAGES && (
        <span className="self-center text-xs tabular-nums text-muted-foreground/70">+{paths.length - MAX_IMAGES}</span>
      )}
    </div>
  );
}
