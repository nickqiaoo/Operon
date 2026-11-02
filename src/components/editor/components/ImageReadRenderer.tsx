import { CompactToolCall } from './compact-tool/CompactToolCall';
import type { PermissionOutcome } from './permission-utils';
import { ReadImagesRow } from './ReadImages';
import type { ToolPartLike } from './toolName';

export { imageReadPathOf } from './ReadImages';

type ImageReadPart = ToolPartLike & { state?: string; toolCallId?: string };

/**
 * A Read of an image standing on its own (the streaming tail, a work group of
 * one): its row with the picture in view, as a folded group shows it — a small
 * thumbnail beside the row on desktop, a gallery tile under it on a phone.
 * Opening the row shows the picture full size (CompactToolCall).
 */
export function ImageReadRenderer({
  toolPart,
  path,
  messageId,
  partIndex,
  onPermissionDecide,
}: {
  toolPart: ImageReadPart;
  path: string;
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <ReadImagesRow paths={[path]}>
      <CompactToolCall toolPart={toolPart} messageId={messageId} partIndex={partIndex} onPermissionDecide={onPermissionDecide} />
    </ReadImagesRow>
  );
}
