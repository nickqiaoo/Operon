import type { UIMessage } from 'ai';
import { getToolDisplayName, type ToolPartLike } from './toolName';

type MessagePart = UIMessage['parts'][number];

/**
 * A Code Mode program: operon's `RunCode`, or OpenCode's `execute` (told apart from other
 * tools named `execute` — ACP's tool kind, say — by the program source it carries). The tools a
 * program calls arrive as parts of their own, tagged with its call id (`programToolCallIdOf`),
 * and render inside its card (CodeProgramRenderer).
 */
export function isCodeProgramTool(part: ToolPartLike): boolean {
  const name = getToolDisplayName(part);
  if (name === 'RunCode') return true;
  const input = part.args ?? part.input;
  return name === 'execute' && typeof input?.code === 'string';
}

/** The program a nested call belongs to (`providerMetadata.<provider>.programToolCallId`), if any. */
export function programToolCallIdOf(part: MessagePart): string | null {
  const meta = (part as { callProviderMetadata?: Record<string, unknown> }).callProviderMetadata;
  if (!meta) return null;
  for (const value of Object.values(meta)) {
    const id = (value as { programToolCallId?: unknown } | null)?.programToolCallId;
    if (typeof id === 'string') return id;
  }
  return null;
}
