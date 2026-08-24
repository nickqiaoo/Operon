import type { UIMessage } from 'ai';

type MessagePart = UIMessage['parts'][number];

/**
 * Extract parentToolCallId from a message part's provider metadata.
 * Claude Code provider stores this in callProviderMetadata['claude-code'].
 */
export function getParentToolCallId(part: MessagePart): string | null {
  const meta = getProviderMetadata(part);
  return meta?.parentToolCallId ?? null;
}

/**
 * Extract toolCallId from a tool message part.
 */
export function getToolCallId(part: MessagePart): string | null {
  if ('toolCallId' in part && typeof part.toolCallId === 'string') {
    return part.toolCallId;
  }
  if (
    'toolInvocation' in part &&
    part.toolInvocation &&
    typeof part.toolInvocation === 'object' &&
    'toolCallId' in part.toolInvocation
  ) {
    return (part.toolInvocation as { toolCallId?: string }).toolCallId ?? null;
  }
  return null;
}

/**
 * Check if a message part is a tool invocation.
 */
export function isToolPart(part: MessagePart): boolean {
  return (
    part.type === 'tool-invocation' ||
    part.type === 'dynamic-tool' ||
    (part.type as string).startsWith('tool-')
  );
}

/**
 * Check if a tool part represents an Agent tool.
 */
export function isTaskToolPart(part: MessagePart): boolean {
  if (!isToolPart(part)) return false;
  const name = getToolName(part);
  return name === 'Agent' || name === 'task';
}

function getToolName(part: MessagePart): string | undefined {
  if ('toolName' in part) return (part as { toolName?: string }).toolName;
  if ('name' in part) return (part as { name?: string }).name;
  if (
    'toolInvocation' in part &&
    part.toolInvocation &&
    typeof part.toolInvocation === 'object'
  ) {
    const inv = part.toolInvocation as { toolName?: string; name?: string };
    return inv.toolName ?? inv.name;
  }
  // For typed tool parts like "tool-Agent", extract from type
  if ((part.type as string).startsWith('tool-')) {
    return (part.type as string).slice(5);
  }
  return undefined;
}

function getProviderMetadata(
  part: MessagePart
): { parentToolCallId?: string } | null {
  const keys = ['claude-code', 'opencode', 'operon'] as const;

  // DynamicToolUIPart has callProviderMetadata directly
  if ('callProviderMetadata' in part) {
    const meta = (part as { callProviderMetadata?: Record<string, unknown> })
      .callProviderMetadata;
    if (meta) {
      for (const key of keys) {
        if (meta[key]) {
          return meta[key] as { parentToolCallId?: string };
        }
      }
    }
  }
  // Wrapped in toolInvocation
  if ('toolInvocation' in part) {
    const inv = part.toolInvocation as {
      callProviderMetadata?: Record<string, unknown>;
    };
    if (inv?.callProviderMetadata) {
      for (const key of keys) {
        if (inv.callProviderMetadata[key]) {
          return inv.callProviderMetadata[key] as {
            parentToolCallId?: string;
          };
        }
      }
    }
  }
  return null;
}
