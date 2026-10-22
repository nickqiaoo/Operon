import { isAskUserQuestionTool } from '../AskUserQuestionRenderer';
import { isExternalAgentTool } from '../ExternalAgentRenderer';
import { createdTaskNumber } from '../TaskCreatedRenderer';
import { isScheduleTaskResult } from '../ScheduleTaskRenderer';
import { getSubagentProgress } from '../gemini-subagent-utils';
import { getToolDisplayName, type ToolPartLike } from '../toolName';
import { normalizeToolState } from '../toolState';
import { isWorkflowToolName } from '../workflowToolName';
import { isCodeProgramTool } from '../codeProgram';

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
 * - A schedule create/update that succeeded (card linking to the Schedule page)
 * - An external agent run/send that returned (agent card with status and approvals)
 * - AskUserQuestion when awaiting approval (needs interactive question UI)
 * - Any tool surfacing live sub-agent progress (Workflow fan-out, Gemini subagents) →
 *   SubAgentRenderer; the generic compact row would just dump the progress JSON.
 * - A Code Mode program (RunCode / OpenCode `execute`) → CodeProgramRenderer, which holds
 *   the calls it made. Work groups use that renderer too, rather than a generic compact row.
 */
const hasToolResult = (part: ToolPartLike) => {
  const record = part as { output?: unknown; result?: unknown };
  return record.output !== undefined || record.result !== undefined;
};

export function isCompactEligible(part: ToolPartLike & { state?: string }): boolean {
  const toolName = getToolDisplayName(part);
  if (EXIT_PLAN_NAMES.has(toolName)) return false;
  if (toolName === 'Agent') return false;
  if (isCodeProgramTool(part)) return false;
  if (isWorkflowToolName(toolName)) return false;
  if (getSubagentProgress(part as ToolPartLike & { result?: unknown; output?: unknown })) return false;
  // AskUserQuestion needs interactive UI when awaiting approval
  if (isAskUserQuestionTool(part) && normalizeToolState(part.state) === 'approval-requested') return false;
  // Only once the call actually yielded a task. A still-streaming or failed
  // create stays compact: TaskCreatedRenderer declines to draw those, so a part
  // pulled out of the group with nothing to render would vanish entirely.
  if (createdTaskNumber(part) !== null) return false;
  if (isScheduleTaskResult(part)) return false;
  // Same condition MessagePartRenderer uses to draw the agent card. Without it
  // the card only showed while the call was the streaming tail; once the parent
  // said anything after it, the run folded into "Ran N commands" as a raw row.
  if (isExternalAgentTool(part) && hasToolResult(part)) return false;
  return true;
}
