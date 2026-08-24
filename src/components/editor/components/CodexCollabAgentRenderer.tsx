import type { ToolPartLike } from './toolName';

export function isCodexCollabAgentTool(toolPart: ToolPartLike): boolean {
  const toolName = toolPart.toolName ?? toolPart.name ?? '';
  return toolName === 'codex_collab_agent';
}
