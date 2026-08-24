import type { ToolPartLike } from './toolName';

export function isOpencodeSubtaskTool(toolPart: ToolPartLike): boolean {
  const toolName = toolPart.toolName ?? toolPart.name ?? '';
  return toolName === 'task' || toolName === 'Subtask';
}
