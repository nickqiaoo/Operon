import { CompactToolCall } from './compact-tool/CompactToolCall';
import type { PermissionOutcome } from './permission-utils';
import { ReadImagesRow, type ToolImage } from './ReadImages';
import type { ToolPartLike } from './toolName';

export { imageReadPathOf, toolImagesOf } from './ReadImages';

type ImageReadPart = ToolPartLike & { state?: string; toolCallId?: string };

/**
 * A tool call with pictures standing on its own (the streaming tail, a work
 * group of one) — a Read of an image, a screenshot tool: its row with the
 * pictures in view, as a folded group shows them — small thumbnails beside the
 * row on desktop, a gallery under it on a phone. Opening the row shows them
 * full size (CompactToolCall).
 */
export function ImageReadRenderer({
  toolPart,
  images,
  messageId,
  partIndex,
  onPermissionDecide,
}: {
  toolPart: ImageReadPart;
  images: ToolImage[];
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <ReadImagesRow images={images}>
      <CompactToolCall toolPart={toolPart} messageId={messageId} partIndex={partIndex} onPermissionDecide={onPermissionDecide} />
    </ReadImagesRow>
  );
}
