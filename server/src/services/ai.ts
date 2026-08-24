// Barrel re-exports — consumers continue to `import * as aiService from '../services/ai.js'`

// State & init
export { initAiService, getSessionManager, registerAgentFinishCallback, shutdown } from './ai/state.js'

// Types
export type { AiChatRequest, CompactRequest, PermissionOutcome, StartChatOptions } from './ai/types.js'

// Message utilities
export { mergeConsecutiveSameRole } from './ai/message-utils.js'

// Approval / Permission
export { applyApprovalResponseToHistory, handlePermissionResponse } from './ai/approval.js'
export { listPendingApprovals, type PendingApproval } from './ai/approval-inbox.js'

// Rewind / Checkpoints
export { rewindToCheckpoint, undoRewind, listCheckpoints, getTurnDiffs, getTurnFileDiffs } from './ai/rewind.js'

// Persistence (exposed for compact-service tests)
export { persistSessionId } from './ai/persistence.js'

// Session / Agent operations
export {
  handleSessionCleanup,
  abortChat,
  injectIntoChat,
  handleCCDynamicSet,
  getContextUsage,
  getClaudeUsageLimits,
  getChatGoal,
  clearChatGoal,
  setChatGoalStatus,
  agentControl,
} from './ai/session-ops.js'

// Workflow runs — folded from the event log; two feeds, three lookups
export {
  getWorkflowRun,
  getWorkflowResult,
  getWorkflowScript,
  getWorkflowAgentChunks,
  listWorkflowRuns,
  getWorkflowFeed,
  getWorkflowRunFeed,
  stopWorkflow,
  type WorkflowRunView,
} from './ai/workflow-runs.js'

// Provider queries
export { getProviders, getProviderModels } from './ai/providers.js'
export {
  invalidateProviderModels,
  warmAllProviders,
} from './ai/provider-models-cache.js'

// Chat flow
export { startChat, handleChat } from './ai/chat-flow.js'

// Live turn attach (multi-surface streaming of one in-flight turn)
export {
  getLiveTurn,
  getLiveTurnStatus,
  subscribeLiveTurnPresence,
  type LiveTurnStatus,
} from './ai/live-turn-hub.js'

// Compact flow
export { handleCompact } from './ai/compact-flow.js'
