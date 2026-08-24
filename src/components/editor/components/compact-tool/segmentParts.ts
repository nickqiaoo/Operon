import type { UIMessage } from 'ai';
import { isToolPart } from '../toolParentUtils';
import { isCompactEligible } from './isCompactEligible';
import type { ToolPartLike } from '../toolName';

type MessagePart = UIMessage['parts'][number];

export type Segment =
  | { type: 'single'; partIndex: number }
  | { type: 'tool-group'; partIndices: number[] };

const isReasoningPart = (part: MessagePart) => part.type === 'reasoning';

const isBlankTextPart = (part: MessagePart) =>
  part.type === 'text' && (part as { text?: string }).text?.trim().length === 0;

/**
 * Groups message parts into segments for rendering.
 *
 * A "work group" absorbs consecutive background-work parts — compact-eligible
 * tool calls AND reasoning ("thinking") parts — so that everything between two
 * prose text blocks collapses into a single foldable block. What breaks a run:
 * prose text, attachments, and tools that own a dedicated renderer
 * (Agent / Workflow / plan review / pending questions).
 *
 * `activeIndex` (the actively-streaming tail part, or -1 when not streaming) is
 * always kept as its own `single` segment, so the live tool/thought render and
 * steer injection keep working while the turn is still in flight.
 */
export function segmentMessageParts(
  parts: MessagePart[],
  childIndices: Set<number>,
  activeIndex = -1,
): Segment[] {
  const segments: Segment[] = [];
  let workRun: number[] = [];

  const flushRun = () => {
    if (workRun.length > 0) {
      segments.push({ type: 'tool-group', partIndices: [...workRun] });
      workRun = [];
    }
  };

  for (let i = 0; i < parts.length; i++) {
    if (childIndices.has(i)) continue;

    const part = parts[i];

    // step-start and blank text parts never render — skip without breaking the
    // run. (Keep the active streaming index as a segment so steer injection fires.)
    if (part.type === 'step-start' || (isBlankTextPart(part) && i !== activeIndex)) continue;

    const isWork =
      i !== activeIndex &&
      ((isToolPart(part) && isCompactEligible(part as ToolPartLike & { state?: string })) ||
        isReasoningPart(part));

    if (isWork) {
      workRun.push(i);
    } else {
      flushRun();
      segments.push({ type: 'single', partIndex: i });
    }
  }

  flushRun();
  return segments;
}
