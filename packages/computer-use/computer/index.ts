/**
 * Operon's Computer Use client: the public window API, which the model sees as
 * `computer.*`.
 *
 * Naming. The model-facing global and this directory are both called `computer`,
 * matching the Computer Use feature in the product. Wire-level names keep their
 * original spelling (`skyshot`, `ComputerUseIPCAppGetSkyshotRequest`,
 * `SKY_CUA_*`) because those are the IPC shapes the contract is defined in, and
 * the sky-wire-oracle suite validates them against a recorded oracle.
 * Renaming them would throw away the comparability the tests depend on.
 *
 * This layer does three things, and the order is part of the contract:
 *   1. Validate arguments: an object carrying a plain string `app` property.
 *   2. Policy and approval: `getAppPolicy`, decide, `createElicitation`, and
 *      throw unless the user explicitly accepts.
 *   3. Substitute appPath: once approved, the `app` that actually goes on the
 *      wire is `target.appPath` from the policy, not the caller's string.
 *
 * The response mappings are equally part of the recorded contract:
 *   - `list_apps` maps `bundleIdentifier` to `id` and drops `appPath` and
 *     `isFrontmost`.
 *   - `get_app_state` sets `app` to appPath, keeps only `url` on a screenshot
 *     (dropping `mimeType`), and prefixes the text with
 *     `<app_specific_instructions>` only on first contact with that app.
 *
 * How the Mac window path is meant to be used:
 *   - The model's main path reads only `text`, the accessibility tree with
 *     element_index values.
 *   - The user-facing live preview (PiP) rides a native remote CAContext /
 *     CALayerHost path, carrying only a contextID and layout metadata. It never
 *     enters a model tool result and never writes a file per frame.
 *   - `screenshot` is reserved for the rare fallback where accessibility fails.
 *   - The native side returns `file://`; older data: URLs are materialised into
 *     `file://` too, keeping the reference short so base64 never floods the
 *     context window.
 *
 * The API is snake_case (`element_index`), with one exception: `disableDiff` on
 * `get_app_state` is camelCase. That inconsistency is part of the contract. Do
 * not "fix" it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MacComputerUseClient,
  type AppIdentifier,
  type DirectionName,
  type MacAppPolicyResult,
  type MacWindowAppState,
  type MouseButtonName,
  type SelectTextSelectionType,
  type SkyDiscoveredApp,
} from "./client.ts";

export {
  SkyComputerUseError,
  SkyComputerUseTransportError,
  ServerErrorCode,
  API_VERSION,
} from "./wire.ts";
export { MacComputerUseClient } from "./client.ts";

// ---------------------- Types the model can see ----------------------

export interface ListAppsApp {
  id: AppIdentifier;
  displayName?: string;
  isRunning?: boolean;
  lastUsedDate?: string;
  useCount?: number;
}

export interface Screenshot {
  url: string;
}

export interface AppState {
  app: AppIdentifier;
  screenshot: Screenshot | null;
  text: string;
}

export interface WindowComputerUseClient {
  readonly target: "mac";
  list_apps(): Promise<ListAppsApp[]>;
  get_app_state(input: { app: AppIdentifier; disableDiff?: boolean }): Promise<AppState>;
  click(input: { app: AppIdentifier; click_count?: number; element_index?: number; mouse_button?: MouseButtonName; x?: number; y?: number }): Promise<void>;
  press_key(input: { app: AppIdentifier; key: string }): Promise<void>;
  type_text(input: { app: AppIdentifier; text: string }): Promise<void>;
  scroll(input: { app: AppIdentifier; direction: DirectionName; element_index: number; pages?: number }): Promise<void>;
  set_value(input: { app: AppIdentifier; element_index: number; value: string }): Promise<void>;
  drag(input: { app: AppIdentifier; from_x: number; from_y: number; to_x: number; to_y: number }): Promise<void>;
  perform_secondary_action(input: { app: AppIdentifier; action: string; element_index: number }): Promise<void>;
  select_text(input: { app: AppIdentifier; element_index: number; text: string; prefix?: string; selection_type?: SelectTextSelectionType; suffix?: string }): Promise<void>;
}

// ------------------------ nodeRepl dependencies ------------------------

interface ElicitationResult {
  action?: string;
  content?: { source?: string } | null;
  _meta?: { persist?: string };
}

interface NodeReplLike {
  createElicitation?: (request: { message: string; meta?: unknown }) => Promise<ElicitationResult>;
  withSuspendedTimeout?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  setResponseMeta?: (meta: unknown) => void;
}

/** Missing this is a hard error: approval must never degrade into permission. */
function requireNodeRepl<K extends keyof NodeReplLike>(key: K): NonNullable<NodeReplLike[K]> {
  const repl = (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
  const fn = repl?.[key];
  if (typeof fn !== "function") throw new Error(`Computer Use requires nodeRepl.${String(key)}`);
  return fn as NonNullable<NodeReplLike[K]>;
}

const TOOL_SURFACE_META_KEY = "codex/toolSurface";

/** Report the app being operated on to the host, for display. A missing
 *  setResponseMeta is not an error. */
function reportToolSurface(bundleIdentifier: string | null): void {
  const repl = (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
  repl?.setResponseMeta?.({
    [TOOL_SURFACE_META_KEY]: {
      app: bundleIdentifier == null ? null : { appId: bundleIdentifier, kind: "appId" },
      kind: "computerUse",
    },
  });
}

// -------------------------- Argument validation --------------------------

/**
 * Validate and freeze the arguments, optionally substituting `app` with another
 * value (appPath, after approval).
 *
 * The strictness is deliberate: `app` has to be a plain data property, never a
 * getter. Otherwise the app shown at approval time and the app actually operated
 * on can differ, which is a time-of-check-to-time-of-use hole. In front of a
 * consent prompt that is not pedantry.
 */
function validateAndFreeze<T extends { app: AppIdentifier }>(input: T, appOverride?: string): T {
  if (typeof input !== "object" || input === null) {
    throw new Error("Computer Use app approval requires an object input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const appDescriptor = descriptors.app;
  if (appDescriptor == null || !("value" in appDescriptor)) {
    throw new Error("Computer Use app approval requires app to be a plain data property");
  }
  const app: unknown = appDescriptor.value;
  if (typeof app !== "string" || app.trim() === "") {
    throw new Error("Computer Use app approval requires a non-empty app");
  }
  const out = {} as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new Error(`Computer Use app approval requires ${key} to be a plain data property`);
    }
    Object.defineProperty(out, key, {
      configurable: false,
      enumerable: descriptor.enumerable,
      value: key === "app" ? (appOverride ?? app) : descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(out) as T;
}

// -------------------------- Policy and approval --------------------------

function decideTarget(policy: MacAppPolicyResult): MacAppPolicyResult["target"] {
  const { bundleIdentifier } = policy.target;
  switch (policy.decision) {
    case "allowed":
      return policy.target;
    case "denied":
      throw new Error(`Computer Use is blocked from using the app '${bundleIdentifier}' by your organization's policy.`);
    case "forbidden":
      throw new Error(`Computer Use is not allowed to use the app '${bundleIdentifier}' for safety reasons.`);
  }
}

async function requestApproval(policy: MacAppPolicyResult): Promise<void> {
  const createElicitation = requireNodeRepl("createElicitation");
  const target = policy.target;
  const result = await createElicitation({
    message: `Allow Computer Use to use "${target.displayName}"?`,
    meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "computer-use",
      connector_name: "Computer Use",
      persist: policy.allowPersistentApproval ? ["session", "always"] : ["session"],
      riskLevel: target.risk,
      ...(target.warningSubtitle == null ? {} : { subtitle: target.warningSubtitle }),
      tool_params: { app: target.bundleIdentifier },
      tool_params_display: [{ name: "app", display_name: "App", value: target.displayName }],
    },
  });
  // Fail closed: only an explicit accept proceeds. A host returning undefined,
  // or throwing, counts as refusal.
  if (result?.action !== "accept") {
    throw new Error(`Computer Use was not approved to use ${target.displayName}`);
  }
}

/**
 * The shared shell around every action: validate, apply policy, ask for
 * approval, substitute appPath, then execute.
 * `withSuspendedTimeout` wraps the execution because approval can leave a user
 * thinking for a long time, and that should not count against the tool timeout.
 */
async function withApproval<TInput extends { app: AppIdentifier }, TOut>(
  input: TInput,
  run: (approved: TInput, target: MacAppPolicyResult["target"]) => Promise<TOut>,
): Promise<TOut> {
  const validated = validateAndFreeze(input);
  const withSuspendedTimeout = requireNodeRepl("withSuspendedTimeout");
  const policy = await client.getAppPolicy(validated.app);
  reportToolSurface(policy.target.bundleIdentifier);
  const target = decideTarget(policy);
  await requestApproval(policy);
  // Once approved, the app that goes on the wire is appPath.
  const approved = validateAndFreeze(validated, target.appPath);
  return await withSuspendedTimeout(() => run(approved, target));
}

// --------------------------- Response mapping ---------------------------

function mapListApps(apps: SkyDiscoveredApp[]): ListAppsApp[] {
  const out: ListAppsApp[] = [];
  for (const app of apps) {
    const id =
      typeof app.bundleIdentifier === "string" && app.bundleIdentifier !== ""
        ? app.bundleIdentifier
        : typeof app.displayName === "string" && app.displayName !== ""
          ? app.displayName
          : "unknown";
    const mapped: ListAppsApp = { id };
    if (app.displayName != null) mapped.displayName = app.displayName;
    if (app.isRunning != null) mapped.isRunning = app.isRunning;
    if (app.lastUsedDate != null) mapped.lastUsedDate = app.lastUsedDate;
    if (app.useCount != null) mapped.useCount = app.useCount;
    // appPath and isFrontmost are deliberately withheld: id is enough for the
    // model, and one fewer confusable identifier is worth having.
    out.push(mapped);
  }
  return out;
}

const INSTRUCTIONS_OPEN = "<app_specific_instructions>";
const INSTRUCTIONS_CLOSE = "</app_specific_instructions>";

/**
 * Codex and current Operon native return short `file://` screenshot references.
 * Keep data URL materialization as compatibility for an older native service so:
 *   - logging / JSON.stringify(state) does not dump megabytes into the model context
 *   - rare `emitImage` fallbacks match the official `file://` skill recipe
 *
 * Host live preview does **not** use this field — it consumes presentation events.
 */
export function materializeScreenshotUrl(
  url: string | null | undefined,
  tmpDir: string = resolveSkyTmpDir(),
): string | null {
  if (url == null || url === "") return null;
  if (url.startsWith("file:")) return url;

  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i.exec(url);
  if (!match) {
    // Unknown scheme — keep as-is rather than invent a path.
    return url;
  }

  const mime = (match[1] ?? "image/png").toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const dir = path.join(tmpDir, "operon-computer-use-shots");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`,
  );
  fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
  return pathToFileUrl(filePath);
}

function resolveSkyTmpDir(): string {
  const repl = (globalThis as { nodeRepl?: { tmpDir?: unknown } }).nodeRepl;
  if (typeof repl?.tmpDir === "string" && repl.tmpDir !== "") return repl.tmpDir;
  return os.tmpdir();
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (process.platform === "win32") {
    const normalized = resolved.replace(/\\/g, "/");
    return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
  }
  return `file://${resolved}`;
}

/**
 * App-specific instructions are attached only on first contact with an app; a
 * second call for the same app carries no prefix. The Set is per client instance
 * and accumulates across calls.
 */
export function mapAppState(
  app: AppIdentifier,
  result: MacWindowAppState,
  appsWithDeliveredInstructions: Set<string>,
): AppState {
  const skyshot = result.skyshot;
  if (skyshot == null) throw new Error("computer-use service did not return app state");
  if (typeof skyshot.text !== "string") {
    throw new Error("computer-use service did not return accessibility text");
  }
  const text = skyshot.text;
  const instructions = result.appSpecificInstructions;
  if (instructions != null && typeof instructions !== "string") {
    throw new Error("computer-use service returned invalid app-specific instructions");
  }
  const resultBundleIdentifier =
    typeof result.app === "object" && result.app != null && typeof result.app.bundleIdentifier === "string"
      ? result.app.bundleIdentifier
      : undefined;
  const needsInstructions =
    typeof instructions === "string" &&
    instructions !== "" &&
    resultBundleIdentifier !== "com.apple.iWork.Numbers" &&
    !appsWithDeliveredInstructions.has(resultBundleIdentifier ?? app);
  if (needsInstructions) appsWithDeliveredInstructions.add(resultBundleIdentifier ?? app);

  const rawUrl = skyshot.screenshot?.url;
  if (rawUrl != null && typeof rawUrl !== "string") {
    throw new Error("computer-use service returned an invalid screenshot URL");
  }
  const url = materializeScreenshotUrl(typeof rawUrl === "string" ? rawUrl : null);
  return {
    app,
    // Present for rare AX-fallback emitImage only. Primary model signal is `text`.
    // Live user preview is host PiP via presentation events — not this field.
    screenshot: url != null ? { url } : null,
    text: needsInstructions ? `${INSTRUCTIONS_OPEN}\n${instructions}\n${INSTRUCTIONS_CLOSE}\n${text}` : text,
  };
}

// ------------------- Public API: the model's `computer` -------------------

const client = new MacComputerUseClient();
const appsWithDeliveredInstructions = new Set<string>();

export const computer: WindowComputerUseClient = {
  target: "mac",

  /** list_apps does not target a specific app, so it needs no approval. */
  async list_apps() {
    reportToolSurface(null);
    return mapListApps(await client.listApps());
  },

  async get_app_state(input) {
    return await withApproval(input, async (approved) => {
      const result = await client.getAppState({ app: approved.app, disableDiff: approved.disableDiff });
      return mapAppState(approved.app, result, appsWithDeliveredInstructions);
    });
  },

  async click(input) {
    await withApproval(input, (a) =>
      client.click({
        app: a.app,
        clickCount: a.click_count,
        elementIndex: a.element_index,
        mouseButton: a.mouse_button,
        x: a.x,
        y: a.y,
      }),
    );
  },

  async press_key(input) {
    await withApproval(input, (a) => client.pressKey({ app: a.app, key: a.key }));
  },

  async type_text(input) {
    await withApproval(input, (a) => client.typeText({ app: a.app, text: a.text }));
  },

  async scroll(input) {
    await withApproval(input, (a) =>
      client.scroll({ app: a.app, direction: a.direction, elementIndex: a.element_index, pages: a.pages }),
    );
  },

  async set_value(input) {
    await withApproval(input, (a) =>
      client.setValue({ app: a.app, elementIndex: a.element_index, value: a.value }),
    );
  },

  async drag(input) {
    await withApproval(input, (a) =>
      client.drag({ app: a.app, fromX: a.from_x, fromY: a.from_y, toX: a.to_x, toY: a.to_y }),
    );
  },

  async perform_secondary_action(input) {
    await withApproval(input, (a) =>
      client.performSecondaryAction({ app: a.app, action: a.action, elementIndex: a.element_index }),
    );
  },

  async select_text(input) {
    await withApproval(input, (a) =>
      client.selectText({
        app: a.app,
        elementIndex: a.element_index,
        text: a.text,
        prefix: a.prefix,
        suffix: a.suffix,
        selection: a.selection_type,
      }),
    );
  },
};
