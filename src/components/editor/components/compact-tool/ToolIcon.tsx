import {
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { categorizeTool, type ToolCategory } from './buildToolGroupSummary';

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileTextIcon,
  write: FilePenIcon,
  search: SearchIcon,
  command: TerminalIcon,
  web: GlobeIcon,
  task: ListTodoIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

/** Leading icon for a tool row, picked by the same categories the group summary uses. */
export function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  const Icon = CATEGORY_ICONS[categorizeTool(toolName)];
  return <Icon className={cn('size-3.5 shrink-0 text-muted-foreground/70', className)} />;
}
