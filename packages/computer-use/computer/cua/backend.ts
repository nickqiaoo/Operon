/**
 * `ComputerUseBackend` on top of the cua-driver daemon.
 *
 * The shapes above this file do not move: the model still calls `computer.*`,
 * still gets an accessibility tree whose rows begin with an `element_index`, and
 * still addresses an app by bundle id or path. This file is where that vocabulary
 * is translated into cua-driver's, which is pid plus window id plus element
 * index against a snapshot.
 *
 * Three translations carry the weight:
 *
 *   1. **app to (pid, window_id)**. Operon's API is app-centric and cua-driver's
 *      is window-centric, so every call resolves the app to a live window first.
 *      The resolution is cached briefly, because an app that just restarted has
 *      a new pid and a cache that outlives that is worse than no cache.
 *   2. **tree rendering**. cua-driver returns a structured `elements` array and
 *      its own markdown. We render our own text from the structured side rather
 *      than passing their markdown through, so the format the model has been
 *      trained on in this product stays byte-comparable.
 *   3. **secondary actions**. Their `click` tool takes an `action` and silently
 *      falls back to AXPress for anything it does not recognise, so an
 *      unrecognised name here must be refused rather than forwarded.
 *
 * See docs/cua-driver-migration/design.md.
 */
import type {
  AppIdentifier,
  ComputerUseBackend,
  DirectionName,
  MacAppPolicyResult,
  MacWindowAppState,
  MouseButtonName,
  RequestOptions,
  SkyDiscoveredApp,
} from "../backend.ts";
import { SkyComputerUseError, SkyComputerUseTransportError, type NativePipeConnection } from "../wire.ts";
import { CuaDaemonTransport } from "./daemon.ts";

/**
 * Apps Computer Use refuses to drive, copied from the Swift engine's
 * `AppSafetyPolicy.blockedBundleIdentifiers`. Password managers, terminals,
 * agent front-ends, the macOS security agents, and Operon itself. This is a
 * safety boundary, so it is duplicated deliberately rather than derived: the
 * engine being replaced must not be the thing that decides what the replacement
 * is allowed to touch.
 */
const BLOCKED_BUNDLE_IDS = new Set([
  "com.1password.1password",
  "com.1password.safari",
  "com.bitwarden.desktop",
  "com.dashlane.dashlanephonefinal",
  "com.lastpass.lastpass",
  "com.nordsec.nordpass",
  "me.proton.pass.electron",
  "me.proton.pass.catalyst",
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "net.kovidgoyal.kitty",
  "com.github.wez.wezterm",
  "com.mitchellh.ghostty",
  "com.raphaelamorim.rio",
  "dev.commandline.waveterm",
  "com.openai.codex",
  "com.openai.codex.alpha",
  "com.openai.codex.beta",
  "com.openai.codex.dev",
  "com.openai.codex.nightly",
  "com.openai.chat.alpha",
  "com.openai.chat.beta",
  "com.openai.chat.nightly",
  "com.openai.chat.mac-debug",
  "com.openai.atlas",
  "com.openai.atlas.alpha",
  "com.openai.atlas.beta",
  "com.apple.usernotificationcenter",
  "com.apple.localauthenticationremoteservice",
  "com.apple.securityagent",
  "com.apple.screencontinuity",
  "top.chatcode.operon",
]);

/**
 * Secondary action names this backend will forward, and where each one goes.
 *
 * cua-driver's `map_action` ends in `_ => "AXPress"`: a name it does not know
 * becomes a click, succeeds, and reports success. On an element advertising both
 * AXPress and AXDecrement that turns "decrement" into "click" silently. So the
 * mapping here is a closed set and anything outside it is refused. Raise and the
 * stepping actions are not `click` at all; they have their own tools.
 */
const CLICK_ACTIONS = new Map<string, string>([
  ["press", "press"],
  ["axpress", "press"],
  ["click", "press"],
  ["showmenu", "show_menu"],
  ["axshowmenu", "show_menu"],
  ["show_menu", "show_menu"],
  ["pick", "pick"],
  ["axpick", "pick"],
  ["confirm", "confirm"],
  ["axconfirm", "confirm"],
  ["cancel", "cancel"],
  ["axcancel", "cancel"],
  ["open", "open"],
  ["axopen", "open"],
]);
const RAISE_ACTIONS = new Set(["raise", "axraise"]);

/** How long a resolved (app -> pid, window) mapping is trusted. */
const RESOLUTION_TTL_MS = 1_500;

interface CuaApp {
  bundle_id?: string;
  name?: string;
  launch_path?: string;
  active?: boolean;
  last_used?: string;
  kind?: string;
}

interface CuaWindow {
  app_name?: string;
  pid: number;
  window_id: number;
  title?: string;
  is_on_screen?: boolean;
  layer?: number;
  z_index?: number;
}

interface CuaElement {
  element_index?: number;
  role?: string;
  label?: string;
  value?: string;
  depth?: number;
  parent_index?: number;
  frame?: { x: number; y: number; w: number; h: number };
}

interface Resolved {
  pid: number;
  windowId: number;
  bundleId: string;
  at: number;
}

export interface CuaDriverBackendOptions {
  /** Opens the daemon socket. In the kernel this is `nodeRepl.nativePipe.createConnection`. */
  connect: (socketPath: string) => Promise<NativePipeConnection>;
  socketPath: string;
  /** Session identity carried on `session_begin`, so the daemon can reap it when
   *  this connection goes away. */
  sessionId?: string;
}

export class CuaDriverBackend implements ComputerUseBackend {
  private readonly options: CuaDriverBackendOptions;
  private transport: CuaDaemonTransport | undefined;
  private connecting: Promise<CuaDaemonTransport> | undefined;
  private readonly resolutions = new Map<string, Resolved>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CuaDriverBackendOptions) {
    this.options = options;
  }

  // ------------------------------- transport -------------------------------

  private async getTransport(): Promise<CuaDaemonTransport> {
    if (this.transport && !this.transport.isClosed) return this.transport;
    if (this.connecting) return await this.connecting;
    this.connecting = (async () => {
      const socket = await this.options.connect(this.options.socketPath);
      const transport = new CuaDaemonTransport(socket);
      const meta = await transport.send({ method: "metadata" });
      if (!meta.ok) throw new SkyComputerUseTransportError("cua-driver did not answer metadata");
      if (this.options.sessionId) {
        await transport.send({ method: "session_begin", args: { session: this.options.sessionId } });
      }
      this.transport = transport;
      return transport;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Serialised like the Swift client's request queue, and for a second reason
   *  here: replies are matched in send order. */
  private run<T>(fn: (transport: CuaDaemonTransport) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => fn(await this.getTransport()));
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private call(name: string, args: Record<string, unknown>, options?: RequestOptions) {
    const timeoutMs = options?.timeoutSeconds != null ? options.timeoutSeconds * 1000 : undefined;
    return this.run((t) => t.call(name, args, timeoutMs));
  }

  // ------------------------------ resolution -------------------------------

  private async listCuaApps(): Promise<CuaApp[]> {
    const result = await this.call("list_apps", {});
    const apps = result.structuredContent?.apps;
    return Array.isArray(apps) ? (apps as CuaApp[]) : [];
  }

  private static matchesQuery(app: CuaApp, query: string): boolean {
    const q = query.toLowerCase();
    if ((app.bundle_id ?? "").toLowerCase() === q) return true;
    if ((app.name ?? "").toLowerCase() === q) return true;
    const launchPath = (app.launch_path ?? "").toLowerCase();
    if (launchPath !== "" && (launchPath === q || q === launchPath.replace(/\/$/, ""))) return true;
    // `app` is often an .app bundle path once policy substituted appPath.
    if (launchPath !== "" && q.endsWith(".app") && launchPath === q) return true;
    return false;
  }

  /** Resolve an Operon `app` to the window cua-driver should act on. */
  private async resolve(app: AppIdentifier): Promise<Resolved> {
    const cached = this.resolutions.get(app);
    if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached;

    const apps = await this.listCuaApps();
    const match = apps.find((candidate) => CuaDriverBackend.matchesQuery(candidate, app));
    if (!match) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: `Computer Use could not find the app '${app}'.`,
        request: { app },
        requestType: "resolve",
      });
    }
    const bundleId = match.bundle_id ?? app;

    const windowsResult = await this.call("list_windows", {});
    const windows = (windowsResult.structuredContent?.windows ?? []) as CuaWindow[];
    const named = windows.filter(
      (w) => (w.app_name ?? "").toLowerCase() === (match.name ?? "").toLowerCase(),
    );
    const candidates = named.length > 0 ? named : windows;
    const onScreen = candidates.filter((w) => w.is_on_screen && (w.layer ?? 0) === 0);
    const pool = onScreen.length > 0 ? onScreen : candidates;
    const best = pool.sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))[0];
    if (!best) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: `The app '${app}' has no window Computer Use can address.`,
        request: { app },
        requestType: "resolve",
      });
    }
    const resolved: Resolved = { pid: best.pid, windowId: best.window_id, bundleId, at: Date.now() };
    this.resolutions.set(app, resolved);
    return resolved;
  }

  /** An action changed the UI, so the next call must re-resolve rather than
   *  trust a window id that may have gone. */
  private invalidate(app: AppIdentifier): void {
    this.resolutions.delete(app);
  }

  // ------------------------------- tree text -------------------------------

  /**
   * Render cua-driver's structured elements in the row format this product's
   * model prompt and tests already parse: leading indent, `element_index`, role,
   * then label and value.
   *
   * Deliberately not their `tree_markdown`: it tags indices as
   * `[element_index N]` mid-line, and every consumer here reads the index off
   * the front of the row.
   */
  static renderTree(elements: CuaElement[]): string {
    const lines: string[] = [];
    for (const element of elements) {
      if (element.element_index == null) continue;
      const indent = "\t".repeat(Math.max(0, element.depth ?? 0));
      const parts = [String(element.element_index), element.role ?? "element"];
      if (element.label != null && element.label !== "") parts.push(element.label);
      if (element.value != null && element.value !== "") parts.push(element.value);
      lines.push(`${indent}${parts.join(" ")}`);
    }
    return lines.join("\n");
  }

  // ------------------------------ the interface -----------------------------

  async listApps(_options?: RequestOptions): Promise<SkyDiscoveredApp[]> {
    const apps = await this.listCuaApps();
    return apps.map((app) => ({
      appPath: app.launch_path ?? null,
      bundleIdentifier: app.bundle_id,
      displayName: app.name,
      isFrontmost: app.active === true,
      isRunning: app.kind === "desktop" ? undefined : undefined,
      lastUsedDate: app.last_used ?? null,
    }));
  }

  /**
   * Policy is Operon's, not the driver's, so it is computed here from the app
   * listing rather than asked of cua-driver, which has no equivalent concept.
   * The decision rules mirror the Swift `AppDiscovery.policyTarget`.
   */
  async getAppPolicy(app: AppIdentifier, _options?: RequestOptions): Promise<MacAppPolicyResult> {
    const query = app.trim();
    if (query === "") {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "Computer Use needs an app name, bundle identifier or path.",
        request: { app },
        requestType: "getAppPolicy",
      });
    }
    const apps = await this.listCuaApps();
    const match = apps.find((candidate) => CuaDriverBackend.matchesQuery(candidate, query));
    const bundleIdentifier = match?.bundle_id ?? (query.includes(".") && !query.includes("/") ? query : "");
    if (bundleIdentifier === "") {
      throw new SkyComputerUseError({
        code: -32_000,
        message: `Computer Use could not find the app '${app}'.`,
        request: { app },
        requestType: "getAppPolicy",
      });
    }
    const forbidden = BLOCKED_BUNDLE_IDS.has(bundleIdentifier.toLowerCase());
    return {
      allowPersistentApproval: !forbidden,
      decision: forbidden ? "forbidden" : "allowed",
      target: {
        appPath: match?.launch_path ?? bundleIdentifier,
        bundleIdentifier,
        displayName: match?.name ?? bundleIdentifier,
        risk: forbidden ? "high" : "low",
        warningSubtitle: forbidden ? "This app is protected for safety reasons." : null,
      },
    };
  }

  async getAppState(
    args: { app: AppIdentifier; disableDiff?: boolean },
    options?: RequestOptions,
  ): Promise<MacWindowAppState> {
    const { pid, windowId, bundleId } = await this.resolve(args.app);
    const result = await this.call(
      "get_window_state",
      { pid, window_id: windowId, include_screenshot: true },
      options,
    );
    const structured = result.structuredContent ?? {};
    const elements = (structured.elements ?? []) as CuaElement[];
    const text = CuaDriverBackend.renderTree(elements);
    const screenshot = typeof structured.screenshot_path === "string"
      ? { url: `file://${structured.screenshot_path}` }
      : null;
    return {
      app: { bundleIdentifier: bundleId, pid },
      skyshot: { text, screenshot },
    };
  }

  async click(
    args: {
      app: AppIdentifier;
      clickCount?: number;
      elementIndex?: number;
      mouseButton?: MouseButtonName | number;
      x?: number;
      y?: number;
    },
    options?: RequestOptions,
  ): Promise<void> {
    const { pid } = await this.resolve(args.app);
    const button = normalizeButton(args.mouseButton);
    const payload: Record<string, unknown> = { pid, count: args.clickCount ?? 1, button };
    if (args.elementIndex != null) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) { payload.x = args.x; payload.y = args.y; }
    else {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "click needs either element_index or x and y.",
        request: args,
        requestType: "click",
      });
    }
    await this.call("click", payload, options);
    this.invalidate(args.app);
  }

  async pressKey(args: { app: AppIdentifier; key: string }, options?: RequestOptions): Promise<void> {
    const { pid } = await this.resolve(args.app);
    await this.call("press_key", { pid, key: args.key }, options);
    this.invalidate(args.app);
  }

  async typeText(args: { app: AppIdentifier; text: string }, options?: RequestOptions): Promise<void> {
    const { pid } = await this.resolve(args.app);
    await this.call("type_text", { pid, text: args.text }, options);
    this.invalidate(args.app);
  }

  async scroll(
    args: { app: AppIdentifier; direction: DirectionName; elementIndex?: number; x?: number; y?: number; pages?: number },
    options?: RequestOptions,
  ): Promise<void> {
    const { pid } = await this.resolve(args.app);
    const payload: Record<string, unknown> = {
      pid,
      direction: normalizeDirection(args.direction),
      by: "page",
      amount: args.pages ?? 1,
    };
    if (args.elementIndex != null) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) { payload.x = args.x; payload.y = args.y; }
    await this.call("scroll", payload, options);
    this.invalidate(args.app);
  }

  async setValue(
    args: { app: AppIdentifier; elementIndex: number; value: string },
    options?: RequestOptions,
  ): Promise<void> {
    const { pid } = await this.resolve(args.app);
    await this.call("set_value", { pid, element_index: args.elementIndex, value: args.value }, options);
    this.invalidate(args.app);
  }

  async drag(
    args: { app: AppIdentifier; fromX: number; fromY: number; toX: number; toY: number },
    options?: RequestOptions,
  ): Promise<void> {
    const { pid } = await this.resolve(args.app);
    await this.call(
      "drag",
      { pid, from_x: args.fromX, from_y: args.fromY, to_x: args.toX, to_y: args.toY },
      options,
    );
    this.invalidate(args.app);
  }

  /**
   * Fan out by action name. See CLICK_ACTIONS for why unknown names are refused
   * instead of forwarded.
   */
  async performSecondaryAction(
    args: { app: AppIdentifier; action: string; elementIndex: number },
    options?: RequestOptions,
  ): Promise<void> {
    const { pid, windowId } = await this.resolve(args.app);
    const key = args.action.trim().toLowerCase().replace(/\s+/g, "_");
    const clickAction = CLICK_ACTIONS.get(key);
    if (clickAction != null) {
      await this.call(
        "click",
        { pid, element_index: args.elementIndex, action: clickAction, count: 1 },
        options,
      );
      this.invalidate(args.app);
      return;
    }
    if (RAISE_ACTIONS.has(key)) {
      await this.call("bring_to_front", { pid, window_id: windowId }, options);
      this.invalidate(args.app);
      return;
    }
    throw new SkyComputerUseError({
      code: -32_000,
      message:
        `Computer Use cannot perform the secondary action '${args.action}' through cua-driver. `
        + `Supported: ${[...new Set(CLICK_ACTIONS.values())].join(", ")}, raise. `
        + `Numeric stepping goes through set_value.`,
      request: args,
      requestType: "perform_secondary_action",
    });
  }

  async selectText(
    args: {
      app: AppIdentifier;
      elementIndex: number;
      text: string;
      prefix?: string;
      suffix?: string;
      selection?: string;
    },
    _options?: RequestOptions,
  ): Promise<void> {
    throw new SkyComputerUseError({
      code: -32_000,
      message:
        "select_text has no cua-driver equivalent yet. Track docs/cua-driver-migration/design.md; "
        + "until it lands, read the element value and use set_value.",
      request: args,
      requestType: "select_text",
    });
  }

  dispose(): void {
    this.transport?.end();
    this.transport = undefined;
    this.resolutions.clear();
  }
}

function normalizeButton(button: MouseButtonName | number | undefined): string {
  if (button == null) return "left";
  if (typeof button === "number") return button === 1 ? "right" : button === 2 ? "middle" : "left";
  const value = button.toLowerCase();
  if (value === "r" || value === "right") return "right";
  if (value === "m" || value === "middle") return "middle";
  return "left";
}

function normalizeDirection(direction: DirectionName): string {
  const value = String(direction).toLowerCase();
  if (value === "u" || value === "up") return "up";
  if (value === "d" || value === "down") return "down";
  if (value === "l" || value === "left") return "left";
  if (value === "r" || value === "right") return "right";
  throw new TypeError(`Invalid scroll direction: ${direction}`);
}
