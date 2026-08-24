/**
 * Public type definitions for ai-sdk-provider-codex-app-server
 */

import type {
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  CollaborationMode,
} from '../protocol/index.js';

/**
 * Logger interface for custom logging
 */
export interface Logger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Approval mode for tool/command execution
 */
export type ApprovalMode = 'never' | 'on-request' | 'on-failure' | 'untrusted';

/**
 * Reviewer used by Codex app-server for approval requests.
 */
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

/**
 * Sandbox mode for file system access
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access' | 'full-access';

/**
 * Codex app-server permission profile id.
 */
export type PermissionProfileId =
  | ':read-only'
  | ':workspace'
  | ':danger-full-access'
  | (string & {});

/**
 * Reasoning effort level
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Codex service tier
 */
export type ServiceTier = 'fast';

/**
 * Thread mode for app-server sessions.
 * - persistent: reuse a single thread across calls
 * - stateless: start a new thread for every call
 */
export type ThreadMode = 'persistent' | 'stateless';

/**
 * User input content types
 */
export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'localImage'; path: string };

/**
 * MCP server base configuration
 */
interface McpServerBase {
  enabled?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

/**
 * MCP server stdio transport configuration
 */
export interface McpServerStdio extends McpServerBase {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * MCP server HTTP transport configuration
 */
export interface McpServerHttp extends McpServerBase {
  transport: 'http';
  url: string;
  bearerToken?: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}

export type McpServerConfig = McpServerStdio | McpServerHttp;

// Import SdkMcpServer type for the union
import type { SdkMcpServer } from '../tools/sdk-mcp-server.js';

/**
 * MCP server config including SDK servers (resolved at runtime)
 * Users can pass SdkMcpServer directly; the provider handles the rest.
 */
export type McpServerConfigOrSdk = McpServerConfig | SdkMcpServer;

/**
 * Session interface for mid-execution control
 */
export interface Session {
  readonly threadId: string;
  readonly turnId: string | null;
  injectMessage(content: string | UserInput[]): Promise<void>;
  interrupt(): Promise<void>;
  isActive(): boolean;
}

/**
 * Command execution approval request params
 */
export interface CommandApprovalRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
  reason?: string;
}

/**
 * File change approval request params
 */
export interface FileChangeApprovalRequestParams {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: Array<{
    path: string;
    type: string;
    diff?: string;
  }>;
}

/**
 * Handler for command execution approval requests
 */
export type CommandApprovalHandler = (
  params: CommandApprovalRequestParams
) => Promise<CommandExecutionRequestApprovalResponse> | CommandExecutionRequestApprovalResponse;

/**
 * Handler for file change approval requests
 */
export type FileChangeApprovalHandler = (
  params: FileChangeApprovalRequestParams
) => Promise<FileChangeRequestApprovalResponse> | FileChangeRequestApprovalResponse;

/**
 * Handler for tool requestUserInput (AskQuestion)
 */
export type ToolRequestUserInputHandler = (
  params: ToolRequestUserInputParams
) => Promise<ToolRequestUserInputResponse> | ToolRequestUserInputResponse;

/**
 * Settings for the Codex App Server provider
 */
export interface CodexAppServerSettings {
  codexPath?: string;
  cwd?: string;
  approvalMode?: ApprovalMode;
  approvalsReviewer?: ApprovalsReviewer;
  sandboxMode?: SandboxMode;
  defaultPermissions?: PermissionProfileId;
  serviceTier?: ServiceTier;
  reasoningEffort?: ReasoningEffort;
  threadMode?: ThreadMode;
  /** MCP servers - can include SdkMcpServer for in-process tools */
  mcpServers?: Record<string, McpServerConfigOrSdk>;
  rmcpClient?: boolean;
  verbose?: boolean;
  logger?: Logger | false;
  onSessionCreated?: (session: Session) => void;
  /** Handler for command execution approval requests */
  onCommandApproval?: CommandApprovalHandler;
  /** Handler for file change approval requests */
  onFileChangeApproval?: FileChangeApprovalHandler;
  /** Handler for tool requestUserInput (AskQuestion) */
  onToolRequestUserInput?: ToolRequestUserInputHandler;
  /** Collaboration mode for plan mode support */
  collaborationMode?: CollaborationMode;
  env?: Record<string, string>;
  baseInstructions?: string;
  configOverrides?: Record<string, string | number | boolean | object>;
  resume?: string;
}

/**
 * Per-call overrides supplied through AI SDK providerOptions
 */
export interface CodexAppServerProviderOptions {
  approvalMode?: ApprovalMode;
  approvalsReviewer?: ApprovalsReviewer;
  sandboxMode?: SandboxMode;
  defaultPermissions?: PermissionProfileId;
  serviceTier?: ServiceTier;
  reasoningEffort?: ReasoningEffort;
  threadMode?: ThreadMode;
  mcpServers?: Record<string, McpServerConfigOrSdk>;
  rmcpClient?: boolean;
  configOverrides?: Record<string, string | number | boolean | object>;
}

/**
 * Supported Codex model IDs
 */
export type CodexModelId =
  | 'gpt-5.1-codex'
  | 'gpt-5.1-codex-mini'
  | 'gpt-5.1-codex-max'
  | 'gpt-5.1'
  | 'gpt-5.2-codex'
  | 'gpt-5.2-codex-mini'
  | 'gpt-5.2-codex-max'
  | 'gpt-5.2'
  | 'gpt-5'
  | 'o3'
  | 'o4-mini'
  | (string & {});
