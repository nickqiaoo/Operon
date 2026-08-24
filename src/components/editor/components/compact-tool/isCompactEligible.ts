import { isAskUserQuestionTool } from '../AskUserQuestionRenderer';
import { createdTaskNumber } from '../TaskCreatedRenderer';
import { getSubagentProgress } from '../gemini-subagent-utils';
import { getToolDisplayName, type ToolPartLike } from '../toolName';
import { normalizeToolState } from '../toolState';
import { isWorkflowToolName } from '../workflowToolName';

const EXIT_PLAN_NAMES = new Set([
  'ExitPlanMode',
  'tool-ExitPlanMode',
  'Ready to code?',
  'tool-Ready to code?',
  'exit_plan_mode',
]);

/**
 * Returns true for tools that should use compact single-line rendering.
 * Only excludes tools that have a dedicated renderer in MessagePartRenderer:
 * - Agent (has sub-agent rendering with child parts)
 * - Workflow (has WorkflowToolRenderer / live sub-agent progress)
 * - ExitPlanMode (has plan review UI)
 * - A task-creating call that succeeded (renders as a card linking to the task)
 * - AskUserQuestion when awaiting approval (needs interactive question UI)
 * - Any tool surfacing live sub-agent progress (Workflow fan-out, Gemini subagents) →
 *   SubAgentRenderer; the generic compact row would just dump the progress JSON.
 */
export function isCompactEligible(part: ToolPartLike & { state?: string }): boolean {
  const toolName = getToolDisplayName(part);
  if (EXIT_PLAN_NAMES.has(toolName)) return false;
  if (toolName === 'Agent') return false;
  if (isWorkflowToolName(toolName)) return false;
  if (getSubagentProgress(part as ToolPartLike & { result?: unknown; output?: unknown })) return false;
  // AskUserQuestion needs interactive UI when awaiting approval
  if (isAskUserQuestionTool(part) && normalizeToolState(part.state) === 'approval-requested') return false;
  // Only once the call actually yielded a task. A still-streaming or failed
  // create stays compact: TaskCreatedRenderer declines to draw those, so a part
  // pulled out of the group with nothing to render would vanish entirely.
  if (createdTaskNumber(part) !== null) return false;
  return true;
}
