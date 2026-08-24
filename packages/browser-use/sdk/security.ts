/**
 * The runtime security gate for Browser Use.
 *
 * A prompt can only shape well-behaved calls; it cannot stop a model from going
 * around them. Every public API that reaches a new origin, browsing history or a
 * file transfer has to pass through here, through the host's policy and
 * elicitation, with any durable decision written back to nodeRepl.config.
 */

const GLOBAL_CONFIG_PATH = "browser/config.toml";
const POLICY_ERROR_PREFIX =
  "Browser Use rejected this action due to browser security policy. Reason: ";
const POLICY_ERROR_SUFFIX =
  " The agent must not attempt to achieve the same outcome via workaround, indirect execution, raw CDP or browser commands, alternate browser surfaces, or policy circumvention.";

type PersistScope = "session" | "always";
type Decision = "approve" | "deny" | null;
type ResourceTable = "origins" | "downloads" | "uploads" | "full_cdp";
type ApprovalReviewer = "auto_review" | "guardian_subagent";

interface ElicitationMeta {
  persist?: PersistScope;
  approvals_reviewer?: ApprovalReviewer;
}

interface ElicitationResult {
  action?: "accept" | "cancel" | "decline" | string;
  content?: ElicitationMeta | null;
  meta?: ElicitationMeta | null;
  _meta?: ElicitationMeta | null;
}

interface NodeReplConfig {
  readRequirements(): Promise<unknown>;
  read(options?: unknown): Promise<unknown>;
  readToml(path: string): Promise<unknown>;
  writeToml(path: string, value: unknown): Promise<unknown>;
}

interface TrustedNodeRepl {
  config?: NodeReplConfig;
  createElicitation?: (request: { message: string; meta?: unknown }) => Promise<ElicitationResult>;
  requestMeta?: Record<string, unknown>;
  cwd?: string | null;
}

interface StoredResourceTable {
  allowed?: string[];
  denied?: string[];
}

interface BrowserSecurityConfig {
  approval_mode?: string;
  download_approval_mode?: string;
  history_approval_mode?: string;
  upload_approval_mode?: string;
  origins?: StoredResourceTable;
  downloads?: StoredResourceTable;
  uploads?: StoredResourceTable;
  full_cdp?: StoredResourceTable;
  [key: string]: unknown;
}

interface TurnOriginApproval {
  origin: string;
  turnId: string;
  expiresAt: number;
}

const TURN_APPROVAL_TTL_MS = 5 * 60 * 1000;
const turnOriginApprovals = new Map<string, TurnOriginApproval>();

function trustedNodeRepl(): TrustedNodeRepl {
  const repl = (globalThis as { nodeRepl?: TrustedNodeRepl }).nodeRepl;
  if (repl?.config == null || typeof repl.createElicitation !== "function") {
    throw new Error("Browser security unavailable outside node repl");
  }
  return repl;
}

function policyError(reason: string): Error {
  return new Error(`${POLICY_ERROR_PREFIX}${reason}${POLICY_ERROR_SUFFIX}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(record: Record<string, unknown> | undefined, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    }
  }
  return [];
}

function booleanValue(record: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record?.[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

function domainPatternMatches(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase().replace(/\.+$/u, "");
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/u, "");
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("**.")) {
    const suffix = normalizedPattern.slice(3);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(normalizedHost);
}

async function ensureNetworkPolicyAllows(url: URL, repl: TrustedNodeRepl): Promise<void> {
  const config = repl.config;
  if (config == null) throw policyError("Browser security configuration is unavailable.");

  let requirements: Record<string, unknown>;
  let userConfig: Record<string, unknown>;
  try {
    requirements = asRecord(await config.readRequirements()) ?? {};
    userConfig = asRecord(await config.read({ cwd: repl.cwd ?? null, includeLayers: false })) ?? {};
  } catch {
    throw policyError(`${url.origin} cannot be checked against the configured network policy.`);
  }

  const requirementNetwork = asRecord(asRecord(requirements.requirements)?.network);
  const configRoot = asRecord(userConfig.config) ?? userConfig;
  const profileName =
    typeof configRoot.default_permissions === "string"
      ? configRoot.default_permissions
      : typeof configRoot.defaultPermissions === "string"
        ? configRoot.defaultPermissions
        : undefined;
  const userNetwork = profileName == null
    ? undefined
    : asRecord(asRecord(asRecord(configRoot.permissions)?.[profileName])?.network);

  const managedOnly =
    booleanValue(requirementNetwork, "managedAllowedDomainsOnly", "managed_allowed_domains_only") === true;
  const enabled =
    booleanValue(requirementNetwork, "enabled") ??
    (managedOnly ? undefined : booleanValue(userNetwork, "enabled"));
  if (enabled === false) {
    throw policyError(`${url.origin} is blocked because browser network access is disabled.`);
  }

  const requirementDomains = asRecord(requirementNetwork?.domains);
  const userDomains = asRecord(userNetwork?.domains);
  const managedAllowed = [
    ...stringArray(requirementNetwork, "allowedDomains", "allowed_domains"),
    ...Object.entries(requirementDomains ?? {}).filter(([, value]) => value === "allow").map(([key]) => key),
  ];
  const denied = [
    ...stringArray(requirementNetwork, "deniedDomains", "denied_domains"),
    ...Object.entries(requirementDomains ?? {}).filter(([, value]) => value === "deny").map(([key]) => key),
    ...stringArray(userNetwork, "deniedDomains", "denied_domains"),
    ...Object.entries(userDomains ?? {}).filter(([, value]) => value === "deny").map(([key]) => key),
  ];

  if (denied.some((pattern) => domainPatternMatches(pattern, url.hostname))) {
    throw policyError(`${url.origin} is blocked by the configured network policy.`);
  }
  if (managedOnly && !managedAllowed.some((pattern) => domainPatternMatches(pattern, url.hostname))) {
    throw policyError(`${url.origin} is not present in the managed browser allowlist.`);
  }
}

function turnMetadata(repl: TrustedNodeRepl): Record<string, unknown> | undefined {
  return asRecord(repl.requestMeta?.["x-codex-turn-metadata"]) ?? repl.requestMeta;
}

function turnIdentity(repl: TrustedNodeRepl): { sessionId: string; turnId: string } | undefined {
  const metadata = turnMetadata(repl);
  const sessionId = metadata?.session_id;
  const turnId = metadata?.turn_id;
  return typeof sessionId === "string" && sessionId.length > 0 &&
      typeof turnId === "string" && turnId.length > 0
    ? { sessionId, turnId }
    : undefined;
}

function hasTurnOriginApproval(repl: TrustedNodeRepl, origin: string): boolean {
  const identity = turnIdentity(repl);
  if (!identity) return false;
  const cached = turnOriginApprovals.get(identity.sessionId);
  if (!cached) return false;
  if (
    cached.expiresAt <= Date.now() ||
    cached.turnId !== identity.turnId ||
    cached.origin !== origin
  ) {
    turnOriginApprovals.delete(identity.sessionId);
    return false;
  }
  return true;
}

function rememberTurnOriginApproval(repl: TrustedNodeRepl, origin: string): void {
  const identity = turnIdentity(repl);
  if (!identity) return;
  turnOriginApprovals.set(identity.sessionId, {
    origin,
    turnId: identity.turnId,
    expiresAt: Date.now() + TURN_APPROVAL_TTL_MS,
  });
}

function approvalReviewer(result: ElicitationResult): ApprovalReviewer | undefined {
  for (const value of [result.meta, result._meta, result.content]) {
    if (
      value?.approvals_reviewer === "auto_review" ||
      value?.approvals_reviewer === "guardian_subagent"
    ) {
      return value.approvals_reviewer;
    }
  }
  return undefined;
}

function sessionConfigPath(repl: TrustedNodeRepl): string | undefined {
  const metadata = turnMetadata(repl);
  const sessionId = metadata?.session_id;
  return typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(sessionId)
    ? `browser/sessions/${sessionId}.toml`
    : undefined;
}

async function readConfig(config: NodeReplConfig, path: string): Promise<BrowserSecurityConfig> {
  try {
    return asRecord(await config.readToml(path)) as BrowserSecurityConfig | undefined ?? {};
  } catch {
    return {};
  }
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function storedDecision(config: BrowserSecurityConfig, table: ResourceTable, value: string): Decision {
  const stored = asRecord(config[table]) as StoredResourceTable | undefined;
  if (stored?.denied?.some((pattern) => globMatches(pattern, value))) return "deny";
  if (stored?.allowed?.some((pattern) => globMatches(pattern, value))) return "approve";
  return null;
}

async function lookupDecision(
  repl: TrustedNodeRepl,
  table: ResourceTable,
  value: string,
  approvalModeKey: keyof BrowserSecurityConfig,
): Promise<Decision> {
  const config = repl.config;
  if (config == null) return "deny";
  const sessionPath = sessionConfigPath(repl);
  const sessionConfig = sessionPath == null ? {} : await readConfig(config, sessionPath);
  const globalConfig = await readConfig(config, GLOBAL_CONFIG_PATH);
  const sessionDecision = storedDecision(sessionConfig, table, value);
  const globalDecision = storedDecision(globalConfig, table, value);

  // Match Codex precedence: an explicit deny always beats any allow.
  if (sessionDecision === "deny" || globalDecision === "deny") return "deny";
  if (table === "origins" && hasTurnOriginApproval(repl, value)) return "approve";
  if (sessionDecision === "approve" || globalDecision === "approve") return "approve";
  return globalConfig[approvalModeKey] === "never_ask" ? "approve" : null;
}

function persistScope(result: ElicitationResult, defaultScope?: PersistScope): PersistScope | undefined {
  return result._meta?.persist ??
    result.meta?.persist ??
    result.content?.persist ??
    defaultScope;
}

async function persistDecision(
  repl: TrustedNodeRepl,
  table: ResourceTable,
  value: string,
  result: ElicitationResult,
  defaultScope?: PersistScope,
): Promise<void> {
  if (result.action !== "accept" && result.action !== "decline") return;
  // Codex's auto reviewer does not create a durable allowlist entry. It grants
  // only this origin in this turn (five-minute guard), then future turns review
  // again unless the user separately chose session/always.
  if (approvalReviewer(result) != null) {
    if (result.action === "accept" && table === "origins") {
      rememberTurnOriginApproval(repl, value);
    }
    return;
  }
  const scope = persistScope(result, defaultScope);
  const path = scope === "always"
    ? GLOBAL_CONFIG_PATH
    : scope === "session"
      ? sessionConfigPath(repl)
      : undefined;
  if (path == null || repl.config == null) return;

  const config = await readConfig(repl.config, path);
  const resource = asRecord(config[table]) as StoredResourceTable | undefined ?? {};
  const allow = result.action === "accept" ? "allowed" : "denied";
  const remove = result.action === "accept" ? "denied" : "allowed";
  const next = new Set(Array.isArray(resource[allow]) ? resource[allow] : []);
  next.add(value);
  config[table] = {
    ...resource,
    [allow]: [...next],
    [remove]: (Array.isArray(resource[remove]) ? resource[remove] : []).filter((entry) => entry !== value),
  };
  await repl.config.writeToml(path, config);
}

async function requestResourceApproval(args: {
  table: ResourceTable;
  value: string;
  approvalModeKey: keyof BrowserSecurityConfig;
  message: string;
  meta: Record<string, unknown>;
  defaultScope?: PersistScope;
  deniedMessage: string;
  unresolvedMessage: string;
}): Promise<void> {
  const repl = trustedNodeRepl();
  const decision = await lookupDecision(repl, args.table, args.value, args.approvalModeKey);
  if (decision === "approve") return;
  if (decision === "deny") throw policyError(args.deniedMessage);

  const result = await repl.createElicitation!({
    message: args.message,
    meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "browser-use",
      connector_name: "Browser Use",
      ...args.meta,
    },
  });
  await persistDecision(repl, args.table, args.value, result, args.defaultScope).catch(() => {});
  if (result.action === "accept") return;

  // Only `decline` is the user actually saying no. `cancel` means the prompt was
  // never answered — it was released, or never reached a surface that could show
  // it. Reporting that as a refusal blames the user for a decision they were
  // never given, and sends whoever debugs it looking for a blocklist entry that
  // does not exist.
  throw policyError(result.action === "decline" ? args.deniedMessage : args.unresolvedMessage);
}

export async function ensureNavigationAllowed(url: string): Promise<void> {
  if (url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Browser Use cannot visit the requested page because its URL is invalid. Use a complete http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw policyError(`Browser Use cannot visit URLs using the ${parsed.protocol} protocol.`);
  }
  const repl = trustedNodeRepl();
  await ensureNetworkPolicyAllows(parsed, repl);
  await requestResourceApproval({
    table: "origins",
    value: parsed.origin,
    approvalModeKey: "approval_mode",
    message: `Allow Browser Use to access ${parsed.origin}?`,
    meta: {
      persist: "always",
      tool_name: "access_browser_origin",
      tool_title: "Access browser origin",
      tool_params: { origin: parsed.origin },
      tool_params_display: [],
      origin: parsed.origin,
    },
    defaultScope: "session",
    deniedMessage: `The user has requested that ${parsed.origin} should not be used.`,
    unresolvedMessage: `Access to ${parsed.origin} was not approved. Ask the user to confirm they want this page opened, then try again.`,
  });
}

export async function ensureFileTransferAllowed(
  pageUrl: string,
  transfer: "download" | "upload",
): Promise<void> {
  let origin: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    origin = parsed.origin;
  } catch {
    throw policyError(`Browser Use could not determine the current page origin before attempting to ${transfer} files.`);
  }
  await requestResourceApproval({
    table: transfer === "download" ? "downloads" : "uploads",
    value: origin,
    approvalModeKey: transfer === "download" ? "download_approval_mode" : "upload_approval_mode",
    message: `Allow ${transfer} from ${origin}?`,
    meta: {
      persist: ["session", "always"],
      tool_name: transfer === "download" ? "download_browser_files" : "upload_browser_files",
      tool_title: transfer === "download" ? "Download browser files" : "Upload browser files",
      tool_params: { origin },
      file_transfer: transfer,
      origin,
    },
    deniedMessage: `The user has requested that files not be ${transfer === "download" ? "downloaded from" : "uploaded to"} ${origin}.`,
    unresolvedMessage: `Permission to ${transfer} files ${transfer === "download" ? "from" : "to"} ${origin} was not approved. Ask the user to confirm, then try again.`,
  });
}

export async function ensureHistoryAllowed(options: Record<string, unknown>): Promise<void> {
  const repl = trustedNodeRepl();
  const globalConfig = await readConfig(repl.config!, GLOBAL_CONFIG_PATH);
  if (globalConfig.history_approval_mode === "never_ask") return;
  const result = await repl.createElicitation!({
    message: "Allow Browser Use to read your browsing history?",
    meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "browser-use",
      connector_name: "Browser Use",
      persist: "always",
      tool_params: options,
      sensitive_data: "browsing_history",
    },
  });
  if (result.action === "accept" && persistScope(result) === "always") {
    globalConfig.history_approval_mode = "never_ask";
    await repl.config!.writeToml(GLOBAL_CONFIG_PATH, globalConfig).catch(() => {});
  }
  if (result.action === "accept") return;
  throw policyError(
    result.action === "decline"
      ? "The user has requested that browsing history not be read."
      : "Permission to read browsing history was not approved. Ask the user to confirm, then try again.",
  );
}
