import type { PermissionDecision } from '../../types.js'
import type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalResponse,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalResponse,
  ToolRequestUserInputResponse,
} from './sdk/protocol/messages.js'

export type ApprovalResolverType = 'command' | 'fileChange' | 'userInput'

export function createResponseForDecision(
  type: ApprovalResolverType,
  decision: PermissionDecision,
): CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse | ToolRequestUserInputResponse {
  if (type === 'command') {
    return {
      decision:
        decision.type === 'deny'
          ? ('decline' as CommandExecutionApprovalDecision)
          : decision.type === 'allow-always'
            ? ('acceptForSession' as CommandExecutionApprovalDecision)
            : ('accept' as CommandExecutionApprovalDecision),
    }
  }

  if (type === 'fileChange') {
    return {
      decision:
        decision.type === 'deny'
          ? ('decline' as FileChangeApprovalDecision)
          : decision.type === 'allow-always'
            ? ('acceptForSession' as FileChangeApprovalDecision)
            : ('accept' as FileChangeApprovalDecision),
    }
  }

  return {
    answers:
      decision.type === 'deny'
        ? {}
        : Object.fromEntries(
            Object.entries(
              (decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {},
            ).map(([key, value]) => [key, { answers: [value] }]),
          ),
  }
}
