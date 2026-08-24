/**
 * JSON-RPC message types for Codex app-server protocol
 *
 * Note: The protocol uses simplified JSON-RPC without the "jsonrpc": "2.0" field
 */

export type RequestId = string | number;

/**
 * JSON-RPC request (client -> server)
 */
export interface JSONRPCRequest {
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC notification (no response expected)
 */
export interface JSONRPCNotification {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC success response
 */
export interface JSONRPCResponse {
  id: RequestId;
  result?: unknown;
}

/**
 * JSON-RPC error response
 */
export interface JSONRPCError {
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCError;

// ============ Initialize ============

export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResult {
  serverInfo?: {
    name: string;
    version: string;
  };
}

// ============ Thread Management ============

export type ProtocolApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
export type ProtocolApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type ProtocolSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ProtocolNetworkAccess = 'restricted' | 'enabled';
export type ProtocolServiceTier = 'fast';
export type ProtocolSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly' }
  | { type: 'externalSandbox'; networkAccess?: ProtocolNetworkAccess }
  | {
      type: 'workspaceWrite';
      writableRoots?: string[];
      networkAccess?: boolean;
      excludeTmpdirEnvVar?: boolean;
      excludeSlashTmp?: boolean;
    };

export interface ThreadStartParams {
  model?: string;
  modelProvider?: string;
  serviceTier?: ProtocolServiceTier;
  cwd?: string;
  approvalPolicy?: ProtocolApprovalPolicy;
  approvalsReviewer?: ProtocolApprovalsReviewer;
  sandbox?: ProtocolSandboxMode;
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  config?: Record<string, unknown>;
}

export interface ThreadStartResult {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier?: ProtocolServiceTier | null;
  cwd: string;
  approvalPolicy: ProtocolApprovalPolicy;
  approvalsReviewer?: ProtocolApprovalsReviewer;
  sandbox: ProtocolSandboxPolicy;
  reasoningEffort?: string;
}

export interface ThreadResumeParams {
  threadId?: string;
  path?: string;
  model?: string;
  serviceTier?: ProtocolServiceTier;
  cwd?: string;
  approvalPolicy?: ProtocolApprovalPolicy;
  approvalsReviewer?: ProtocolApprovalsReviewer;
  sandbox?: ProtocolSandboxMode;
  config?: Record<string, unknown>;
}

export interface ThreadForkParams {
  threadId: string;
  modelOverride?: string;
  sandboxOverride?: ProtocolSandboxMode;
}

export interface ThreadRollbackParams {
  threadId: string;
  toTurnId: string;
}

export interface ThreadArchiveParams {
  threadId: string;
}

export interface ThreadListParams {
  cursor?: string;
  limit?: number;
  modelProviders?: string[];
}

export interface Thread {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  path?: string;
  cwd?: string;
  cliVersion?: string;
  source?: string;
  gitInfo?: {
    branch: string;
    sha: string;
    isDirty: boolean;
  };
  turns: Turn[];
}

// ============ Turn Management ============

export interface UserInputText {
  type: 'text';
  text: string;
}

export interface UserInputImage {
  type: 'image';
  imageUrl: string;
}

export interface UserInputLocalImage {
  type: 'localImage';
  path: string;
}

export interface UserInputSkill {
  type: 'skill';
  name: string;
  path?: string;
}

export type ProtocolUserInput = UserInputText | UserInputImage | UserInputLocalImage | UserInputSkill;

export interface TurnStartParams {
  threadId: string;
  input: ProtocolUserInput[];
  cwd?: string;
  approvalPolicy?: ProtocolApprovalPolicy;
  approvalsReviewer?: ProtocolApprovalsReviewer;
  sandboxPolicy?: ProtocolSandboxPolicy;
  model?: string;
  serviceTier?: ProtocolServiceTier;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  outputSchema?: Record<string, unknown>;
  collaborationMode?: CollaborationMode;
}

export interface TurnStartResult {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnError {
  code?: string;
  message?: string;
  codexErrorInfo?: string;
  additionalDetails?: unknown;
}

export interface Turn {
  id: string;
  items: TurnItem[];
  status:
    | 'completed'
    | 'interrupted'
    | 'failed'
    | 'inProgress'
    | 'Completed'
    | 'Interrupted'
    | 'Failed';
  error?: TurnError | null;
}

// ============ Turn Items ============

export interface UserMessage {
  type: 'userMessage' | 'UserMessage';
  id: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; imageUrl: string }
    | { type: 'image'; base64: string; mimeType: string }
  >;
}

export interface AgentMessage {
  type: 'agentMessage' | 'AgentMessage';
  id: string;
  text: string;
}

export interface Reasoning {
  type: 'reasoning' | 'Reasoning';
  id: string;
  summary: string[] | string;
  content: string[] | string;
}

export interface CommandExecution {
  type: 'commandExecution' | 'CommandExecution';
  id: string;
  command: string;
  cwd: string;
  processId?: string | number | null;
  status:
    | 'running'
    | 'completed'
    | 'inProgress'
    | 'failed'
    | 'declined'
    | 'Running'
    | 'Completed';
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface FileChange {
  type: 'fileChange' | 'FileChange';
  id: string;
  changes: Array<Record<string, unknown>>;
  status:
    | 'running'
    | 'completed'
    | 'inProgress'
    | 'failed'
    | 'declined'
    | 'Running'
    | 'Completed';
}

export interface McpToolCall {
  type: 'mcpToolCall' | 'McpToolCall';
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
  status: 'running' | 'completed' | 'inProgress' | 'failed' | 'Running' | 'Completed';
  result?: unknown | null;
  error?: unknown | null;
  durationMs?: number | null;
}

export interface WebSearch {
  type: 'webSearch' | 'WebSearch';
  id: string;
  query: string;
}

export interface ImageView {
  type: 'imageView' | 'ImageView';
  id: string;
  path: string;
}

export interface ContextCompaction {
  type: 'contextCompaction';
  id: string;
}

// ============ AskQuestion (item/tool/requestUserInput) ============

export interface ToolRequestUserInputOption {
  label: string;
  description?: string;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: ToolRequestUserInputOption[] | null;
}

export interface ToolRequestUserInputAnswer {
  answers: string[];
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>;
}

// ============ Subagent (collabAgentToolCall) ============

export type CollabAgentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent';

export type CollabAgentToolCallStatus =
  | 'inProgress'
  | 'completed'
  | 'failed';

export type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';

export interface CollabAgentState {
  agentId: string;
  name?: string;
  status: CollabAgentStatus;
}

export interface CollabAgentToolCall {
  type: 'collabAgentToolCall' | 'CollabAgentToolCall';
  id: string;
  tool: CollabAgentTool;
  prompt?: string;
  agentId?: string;
  status: CollabAgentToolCallStatus;
  /** Thread ID of the agent issuing the collab request */
  senderThreadId?: string;
  /** Thread IDs of the receiving agents (spawned sub-agents) */
  receiverThreadIds?: string[];
  /** Model requested for the spawned agent */
  model?: string | null;
  agentsStates?: CollabAgentState[] | Record<string, CollabAgentState>;
  result?: unknown;
  error?: unknown;
  durationMs?: number | null;
}

// ============ Plan Mode ============

export type ModeKind = 'plan' | 'default';

export interface CollaborationSettings {
  model: string;
  reasoning_effort: string | null;
  developer_instructions: string | null;
}

export interface CollaborationMode {
  mode: ModeKind;
  settings: CollaborationSettings;
}

export interface PlanItem {
  type: 'plan' | 'Plan';
  id: string;
  text: string;
}

export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

// ============ Model Discovery ============

export interface ModelListParams {
  modelProviders?: string[];
}

export interface ReasoningEffortOption {
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  description: string;
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface ModelListResult {
  data: ModelInfo[];
  nextCursor: string | null;
}

export type TurnItem =
  | UserMessage
  | AgentMessage
  | Reasoning
  | CommandExecution
  | FileChange
  | McpToolCall
  | WebSearch
  | ImageView
  | CollabAgentToolCall
  | PlanItem
  | ContextCompaction;

// ============ Approval Responses ============

/**
 * Execution policy amendment - list of command patterns to allow
 */
export type ExecPolicyAmendment = Array<string>;

/**
 * Decision for command execution approval
 */
export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | 'decline'
  | 'cancel';

/**
 * Response to item/commandExecution/requestApproval
 */
export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

/**
 * Decision for file change approval
 */
export type FileChangeApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

/**
 * Response to item/fileChange/requestApproval
 */
export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision;
}

// ============ Skill Discovery ============

export interface SkillListParams {
  cwds?: string[]
  forceReload?: boolean
}

export interface SkillListItem {
  name: string
  description: string
  enabled: boolean
}

export interface SkillListResult {
  data: { cwd: string; skills: SkillListItem[]; errors: unknown[] }[]
}

// ============ Thread Goal ============

/**
 * Goal lifecycle statuses (decoded from Codex desktop `sp`/`cp` predicates):
 * - active: codex is actively pursuing the goal (each goal/set active runs one turn)
 * - paused/blocked/usageLimited: stopped but resumable
 * - budgetLimited/complete: terminal (not resumable)
 */
export type CodexGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export interface CodexGoal {
  threadId: string
  objective: string
  status: CodexGoalStatus
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number
  updatedAt?: number
}

export interface GoalSetParams {
  threadId: string
  /** Omitted on continuation (objective already persisted on the thread). */
  objective?: string
  status?: CodexGoalStatus
  tokenBudget?: number | null
}

export interface GoalGetParams {
  threadId: string
}

export interface GoalClearParams {
  threadId: string
}

export interface GoalResult {
  goal: CodexGoal
}

export interface GoalClearResult {
  cleared: boolean
}

export interface GoalUpdatedParams {
  threadId: string
  turnId?: string | null
  goal: CodexGoal
}

export interface GoalClearedParams {
  threadId: string
}
