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
  ClickAction,
  ClipboardContents,
  ComputerUseBackend,
  DirectionName,
  MacAppPolicyResult,
  MacWindowAppState,
  MouseButtonName,
  RequestOptions,
  ScreenSize,
  SkyDiscoveredApp,
  VerifyStateResult,
  WindowFrame,
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
/** How long a resolved (app -> pid, window) mapping is trusted. */
const RESOLUTION_TTL_MS = 1_500;

/** The window an action should address: frontmost (lowest z) of the ordinary,
 *  on-screen ones, falling back to any window when none is on screen. */
function pickWindow(windows: CuaWindow[]): CuaWindow | undefined {
  const onScreen = windows.filter((w) => w.is_on_screen && (w.layer ?? 0) === 0);
  const pool = onScreen.length > 0 ? onScreen : windows;
  return [...pool].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))[0];
}

interface CuaApp {
  bundle_id?: string;
  name?: string;
  launch_path?: string;
  active?: boolean;
  last_used?: string;
  kind?: string;
  /** False for an installed-but-not-running app, whose `pid` is then 0. */
  running?: boolean;
  pid?: number;
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
  /**
   * On-screen geometry. Absent for a node the app has not laid out — a row a
   * virtualised list has scrolled past, most often. Such a node is in the tree
   * but cannot be acted on: the daemon's background-input gate cannot prove it
   * belongs to the target window and refuses with `element_outside_target_window`.
   * That is why the renderer marks it; before, the model could not tell.
   */
  frame?: { x: number; y: number; w: number; h: number };
  /** False for a greyed-out control. Acting on one silently does nothing. */
  enabled?: boolean;
  /** Current selection state, for rows, cells, tabs and radio buttons. */
  selected?: boolean;
  /** Inside a web view rather than native AX. */
  in_web_content?: boolean;
}

interface Resolved {
  pid: number;
  windowId: number;
  bundleId: string;
  at: number;
  /**
   * Handle from the last `get_window_state`, in cua-driver's `s########` form.
   *
   * Every element-indexed action carries it, because the driver's contract is
   * "required when targeting by element_index; stale snapshots fail closed".
   * That is the guard against the failure Operon otherwise has no protection
   * for now that automatic intervention detection is out of scope: the user
   * touches the app between the snapshot and the action, the index map no
   * longer describes the screen, and the click lands on the wrong thing. With
   * the handle attached the driver refuses instead, and says to re-snapshot.
   */
  snapshotId?: string;
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
    /**
     * The bundle's own name, which is not localized.
     *
     * `name` is: a running System Settings reports "系统设置" on a Chinese Mac,
     * so an English request stops matching the moment the app is open — the app
     * resolves while closed, then vanishes once launched. The Swift engine
     * avoids this by also comparing the executable name
     * (`AppDiscovery.resolvedRunningApp`), and `launch_path`'s basename is the
     * same string.
     */
    const bundleName = launchPath.split("/").pop()?.replace(/\.app$/, "") ?? "";
    if (bundleName !== "" && bundleName === q.replace(/\.app$/, "")) return true;
    /**
     * Last resort: the bundle id's final segment ("com.apple.finder" → "finder").
     * Some system apps report no `launch_path` at all — Finder is one — and
     * would otherwise be unreachable by their English name on a localized Mac.
     * Guarded to non-bundle-id queries so "com.apple.mail" cannot match some
     * other app whose id happens to end in "mail".
     */
    if (!q.includes(".") && q.length >= 3) {
      const tail = (app.bundle_id ?? "").toLowerCase().split(".").pop() ?? "";
      if (tail !== "" && tail === q.replace(/\s+/g, "")) return true;
    }
    return false;
  }

  /** The frontmost ordinary window belonging to `pid`, or undefined. */
  private async windowFor(pid: number): Promise<CuaWindow | undefined> {
    const result = await this.call("list_windows", { pid });
    const windows = (result.structuredContent?.windows ?? []) as CuaWindow[];
    // Filter by pid again: the parameter is documented as a filter, but a window
    // addressed by the wrong pid is the exact failure this whole function exists
    // to prevent, so it is not worth trusting on the driver's word alone.
    return pickWindow(windows.filter((w) => w.pid === pid));
  }

  /**
   * Resolve an Operon `app` to the window cua-driver should act on.
   *
   * Two things here are load-bearing, and both were learned the hard way.
   *
   * **A closed app is launched, not failed.** `list_apps` reports every
   * *installed* app, so an app the user has never opened matches by name and
   * then has no window at all. The Swift engine launches it and polls for up to
   * five seconds (`AppDiscovery.resolve`), and every model prompt written
   * against this product assumes that: "open System Settings and…" is a single
   * request, not two.
   *
   * **Never fall back to another app's window.** The first version of this
   * picked the frontmost window of *any* app when the target had none, so
   * asking for a closed System Settings silently returned whatever happened to
   * be in front — OrbStack, in the report that found this — and every following
   * click landed there, cached for the resolution TTL. Addressing the wrong
   * application is far worse than refusing, so an unresolvable app now throws.
   */
  private async resolve(app: AppIdentifier): Promise<Resolved> {
    const cached = this.resolutions.get(app);
    if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached;

    const find = async () => {
      const apps = await this.listCuaApps();
      return apps.find((candidate) => CuaDriverBackend.matchesQuery(candidate, app));
    };
    let match = await find();
    if (!match) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: `Computer Use could not find the app '${app}'.`,
        request: { app },
        requestType: "resolve",
      });
    }
    const bundleId = match.bundle_id ?? app;

    let best = match.pid ? await this.windowFor(match.pid) : undefined;
    if (!best) {
      // Not running, or running with no addressable window yet (a just-launched
      // app answers `list_apps` before its window exists).
      const launched = await this.call(
        "launch_app",
        match.bundle_id ? { bundle_id: match.bundle_id } : { name: match.name ?? app },
      );
      // `launch_app` already reports the app it started, windows included, so the
      // common case costs no extra round trip.
      const app_ = (launched.structuredContent?.app ?? {}) as CuaApp & { windows?: CuaWindow[] };
      let pid = typeof app_.pid === "number" && app_.pid > 0 ? app_.pid : 0;
      if (pid) best = pickWindow((app_.windows ?? []).filter((w) => w.pid === pid));
      // Re-find by bundle id, never by the original query: a launched app reports
      // its *localized* name ("系统设置" for a "System Settings" request), so
      // re-running the name match here would lose the app it just started.
      for (let attempt = 0; attempt < 20 && !best; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!pid) {
          const again = (await this.listCuaApps()).find(
            (candidate) => candidate.bundle_id != null && candidate.bundle_id === match.bundle_id,
          );
          pid = typeof again?.pid === "number" && again.pid > 0 ? again.pid : 0;
        }
        if (pid) best = await this.windowFor(pid);
      }
    }
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

  /**
   * An action changed the UI, so the index map from the last snapshot is gone.
   * The window itself usually is not, so only the snapshot handle is dropped;
   * the pid and window id keep their own short TTL. Re-resolving those on every
   * action would cost two extra round trips for nothing.
   */
  private invalidateSnapshot(app: AppIdentifier): void {
    const resolved = this.resolutions.get(app);
    if (resolved) resolved.snapshotId = undefined;
  }

  /**
   * The snapshot handle for `app`, taking one if there is none.
   *
   * Mirrors the Swift engine's `currentSnapshot`, which also takes a fresh tree
   * when a call arrives without one, so an action that follows no explicit
   * `get_app_state` keeps working.
   */
  private async ensureSnapshot(app: AppIdentifier): Promise<Resolved> {
    const resolved = await this.resolve(app);
    if (resolved.snapshotId != null) return resolved;
    // Deliberately unfiltered: this snapshot backs an action addressed by an
    // index the model already holds, and a `query`-scoped walk would produce a
    // different index map.
    await this.getAppState({ app });
    return await this.resolve(app);
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
    // "No frame" only means "off screen" when the tree carries geometry at all.
    // Some surfaces report none for any node, and marking every row `offscreen`
    // there would be noise that says nothing.
    const hasGeometry = elements.some((element) => element.frame != null);
    const lines: string[] = [];
    for (const element of elements) {
      if (element.element_index == null) continue;
      const indent = "\t".repeat(Math.max(0, element.depth ?? 0));
      const parts = [String(element.element_index), element.role ?? "element"];
      if (element.label != null && element.label !== "") parts.push(element.label);
      if (element.value != null && element.value !== "") parts.push(element.value);
      // Suffixed rather than inserted, so the leading `<index> <role>` shape every
      // consumer parses is untouched.
      const flags: string[] = [];
      if (element.enabled === false) flags.push("disabled");
      if (element.selected === true) flags.push("selected");
      if (hasGeometry && element.frame == null) flags.push("offscreen");
      if (flags.length > 0) parts.push(`(${flags.join(", ")})`);
      lines.push(`${indent}${parts.join(" ")}`);
    }
    return lines.join("\n");
  }

  /**
   * A header for the tree, when there is something about it the model must know.
   *
   * Three facts the daemon reports and this used to drop on the floor:
   *
   *  - the walk was capped, so rows the model needs may simply be missing;
   *  - `elements_complete: false`, i.e. the daemon itself says the tree is partial
   *    even when it returned everything it walked;
   *  - an input route the daemon has already refused for this window, which
   *    predicts the failure of an action rather than reporting it afterwards.
   *
   * Empty when there is nothing to say, so an ordinary tree gains no preamble.
   */
  static renderTreeNotes(structured: Record<string, unknown>, filtered = false): string {
    const notes: string[] = [];
    const returned = numberOr(structured.returned_element_count, NaN);
    const total = numberOr(structured.total_element_count, NaN);
    const partial = Number.isFinite(returned) && Number.isFinite(total) && returned < total;
    if (partial && filtered) {
      // A filtered walk returns fewer nodes by definition. Calling that a cap
      // would be wrong, and telling the caller to "pass query" when they just
      // did is worse than saying nothing.
      notes.push(`query matched ${returned} of ${total} elements`);
    } else if (partial) {
      notes.push(
        `showing ${returned} of ${total} elements (the walk was capped — raise max_elements, `
        + `or pass query to filter)`,
      );
    } else if (structured.elements_complete === false && !filtered) {
      notes.push(
        "this tree is incomplete: the accessibility walk did not reach every node "
        + "(pass query to filter, or max_depth / max_elements to bound it differently)",
      );
    }
    const routes = (structured.background_input as { routes?: unknown } | undefined)?.routes;
    if (Array.isArray(routes)) {
      const refused = routes
        .filter((r): r is { route?: string; status?: string; reason?: string } =>
          typeof r === "object" && r != null)
        .filter((r) => r.status === "refused" && typeof r.route === "string");
      for (const route of refused) {
        notes.push(
          `the '${route.route}' input route is refused for this window`
          + `${route.reason ? ` (${route.reason})` : ""} — actions using it will fail`,
        );
      }
    }
    return notes.length === 0 ? "" : notes.map((note) => `[${note}]`).join("\n");
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
    args: {
      app: AppIdentifier;
      disableDiff?: boolean;
      /**
       * Case-insensitive filter: matching actionable rows plus their actionable
       * ancestors. The reason this is worth having is scale — a Chrome window
       * reports over 1500 nodes, and rendering all of them costs the model far
       * more context than finding the one row it was looking for.
       */
      query?: string;
      /** Cap on nodes walked (daemon default is its own). */
      maxElements?: number;
      /** Cap on walk depth (daemon default 25). */
      maxDepth?: number;
    },
    options?: RequestOptions,
  ): Promise<MacWindowAppState> {
    const resolved = await this.resolve(args.app);
    const request: Record<string, unknown> = {
      pid: resolved.pid,
      window_id: resolved.windowId,
      include_screenshot: true,
    };
    if (args.query != null && args.query !== "") request.query = args.query;
    if (args.maxElements != null) request.max_elements = args.maxElements;
    if (args.maxDepth != null) request.max_depth = args.maxDepth;
    const result = await this.call("get_window_state", request, options);
    const structured = result.structuredContent ?? {};
    // Present only when the window scope resolved; an observation-only reply has
    // no index map, so there is nothing to hand a later action.
    resolved.snapshotId = typeof structured.snapshot_id === "string" ? structured.snapshot_id : undefined;
    const elements = (structured.elements ?? []) as CuaElement[];
    const notes = CuaDriverBackend.renderTreeNotes(structured, request.query != null);
    const tree = CuaDriverBackend.renderTree(elements);
    const text = notes === "" ? tree : `${notes}\n${tree}`;
    const screenshot = screenshotUrl(structured);
    return {
      app: { bundleIdentifier: resolved.bundleId, pid: resolved.pid },
      skyshot: { text, screenshot },
    };
  }

  /** Address one window and, when the target is an element, the snapshot its
   *  index came from. */
  private async targetArgs(app: AppIdentifier, byElement: boolean): Promise<Record<string, unknown>> {
    const resolved = byElement ? await this.ensureSnapshot(app) : await this.resolve(app);
    const args: Record<string, unknown> = { pid: resolved.pid, window_id: resolved.windowId };
    if (byElement && resolved.snapshotId != null) args.snapshot_id = resolved.snapshotId;
    return args;
  }

  async click(
    args: {
      app: AppIdentifier;
      clickCount?: number;
      elementIndex?: number;
      mouseButton?: MouseButtonName | number;
      /**
       * The AX action to invoke instead of an ordinary press.
       *
       * This is the daemon's own model: one `click` tool with an action
       * parameter, whose values are a closed set. It used to be hidden behind a
       * separate `performSecondaryAction` method that took a free-form name and
       * translated it — which could not work here, because cua-driver's tree
       * does not report which actions an element exposes, so nothing could tell
       * the caller what to pass.
       */
      action?: ClickAction;
      x?: number;
      y?: number;
    },
    options?: RequestOptions,
  ): Promise<void> {
    const byElement = args.elementIndex != null;
    if (args.action != null && !byElement) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "click action requires element_index: an AX action is sent to an element, not a point.",
        request: args,
        requestType: "click",
      });
    }
    const payload: Record<string, unknown> = {
      ...(await this.targetArgs(args.app, byElement)),
      count: args.clickCount ?? 1,
      button: normalizeButton(args.mouseButton),
    };
    if (args.action != null) payload.action = args.action;
    if (byElement) payload.element_index = args.elementIndex;
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
    this.invalidateSnapshot(args.app);
  }

  async pressKey(args: { app: AppIdentifier; key: string }, options?: RequestOptions): Promise<void> {
    await this.call("press_key", { ...(await this.targetArgs(args.app, false)), key: args.key }, options);
    this.invalidateSnapshot(args.app);
  }

  async typeText(args: { app: AppIdentifier; text: string }, options?: RequestOptions): Promise<void> {
    await this.call("type_text", { ...(await this.targetArgs(args.app, false)), text: args.text }, options);
    this.invalidateSnapshot(args.app);
  }

  async scroll(
    args: { app: AppIdentifier; direction: DirectionName; elementIndex?: number; x?: number; y?: number; pages?: number },
    options?: RequestOptions,
  ): Promise<void> {
    const byElement = args.elementIndex != null;
    const payload: Record<string, unknown> = {
      ...(await this.targetArgs(args.app, byElement)),
      direction: normalizeDirection(args.direction),
      by: "page",
      amount: args.pages ?? 1,
    };
    if (byElement) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) { payload.x = args.x; payload.y = args.y; }
    await this.call("scroll", payload, options);
    this.invalidateSnapshot(args.app);
  }

  async setValue(
    args: { app: AppIdentifier; elementIndex: number; value: string },
    options?: RequestOptions,
  ): Promise<void> {
    await this.call(
      "set_value",
      { ...(await this.targetArgs(args.app, true)), element_index: args.elementIndex, value: args.value },
      options,
    );
    this.invalidateSnapshot(args.app);
  }

  async drag(
    args: { app: AppIdentifier; fromX: number; fromY: number; toX: number; toY: number },
    options?: RequestOptions,
  ): Promise<void> {
    await this.call(
      "drag",
      {
        ...(await this.targetArgs(args.app, false)),
        from_x: args.fromX, from_y: args.fromY, to_x: args.toX, to_y: args.toY,
      },
      options,
    );
    this.invalidateSnapshot(args.app);
  }

  /**
   * Fan out by action name. See CLICK_ACTIONS for why unknown names are refused
   * instead of forwarded.
   */
  /** Raise the app's window without clicking in it. */
  async bringToFront(args: { app: AppIdentifier }, options?: RequestOptions): Promise<void> {
    await this.call("bring_to_front", await this.targetArgs(args.app, false), options);
    this.invalidateSnapshot(args.app);
  }

  // ---------------------------------------------------------------------
  // Capabilities the Swift-shaped interface used to hide. See backend.ts.
  // ---------------------------------------------------------------------

  async hotkey(
    args: { app: AppIdentifier; keys: readonly string[]; elementIndex?: number; x?: number; y?: number },
    options?: RequestOptions,
  ): Promise<void> {
    if (args.keys.length === 0) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "hotkey needs at least one key, e.g. ['cmd', 'c'].",
        request: args,
        requestType: "hotkey",
      });
    }
    const byElement = args.elementIndex != null;
    const payload: Record<string, unknown> = {
      ...(await this.targetArgs(args.app, byElement)),
      keys: [...args.keys],
    };
    if (byElement) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) {
      payload.x = args.x;
      payload.y = args.y;
    }
    await this.call("hotkey", payload, options);
    // A chord is the most likely thing in this file to have rearranged the UI.
    this.invalidateSnapshot(args.app);
  }

  async invokeMenu(
    args: { app: AppIdentifier; path: readonly string[] },
    options?: RequestOptions,
  ): Promise<void> {
    if (args.path.length === 0) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "invoke_menu needs a path, e.g. ['File', 'Save'].",
        request: args,
        requestType: "invoke_menu",
      });
    }
    // Menu targeting is window-scoped but never element-scoped: the menu bar is
    // not inside the window, so a snapshot handle would mean nothing here.
    await this.call(
      "invoke_menu",
      { ...(await this.targetArgs(args.app, false)), path: [...args.path] },
      options,
    );
    this.invalidateSnapshot(args.app);
  }

  async doubleClick(
    args: { app: AppIdentifier; elementIndex?: number; x?: number; y?: number },
    options?: RequestOptions,
  ): Promise<void> {
    const byElement = args.elementIndex != null;
    const payload: Record<string, unknown> = await this.targetArgs(args.app, byElement);
    if (byElement) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) {
      payload.x = args.x;
      payload.y = args.y;
    } else {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "double_click needs either element_index or x and y.",
        request: args,
        requestType: "double_click",
      });
    }
    await this.call("double_click", payload, options);
    this.invalidateSnapshot(args.app);
  }

  async rightClick(
    args: { app: AppIdentifier; elementIndex?: number; x?: number; y?: number; modifiers?: readonly string[] },
    options?: RequestOptions,
  ): Promise<void> {
    const byElement = args.elementIndex != null;
    const payload: Record<string, unknown> = await this.targetArgs(args.app, byElement);
    if (byElement) payload.element_index = args.elementIndex;
    else if (args.x != null && args.y != null) {
      payload.x = args.x;
      payload.y = args.y;
    } else {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "right_click needs either element_index or x and y.",
        request: args,
        requestType: "right_click",
      });
    }
    // The daemon accepts modifiers on the pixel path only.
    if (args.modifiers?.length && !byElement) payload.modifier = [...args.modifiers];
    await this.call("right_click", payload, options);
    this.invalidateSnapshot(args.app);
  }

  async setWindowFrame(
    args: { app: AppIdentifier; x: number; y: number; width: number; height: number },
    options?: RequestOptions,
  ): Promise<WindowFrame> {
    const result = await this.call(
      "set_window_frame",
      {
        ...(await this.targetArgs(args.app, false)),
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
      },
      options,
    );
    // Resizing re-lays-out the window, so every cached element index is stale.
    this.invalidateSnapshot(args.app);
    const structured = result.structuredContent ?? {};
    const frame = (structured.frame ?? structured) as Record<string, unknown>;
    return {
      x: numberOr(frame.x, args.x),
      y: numberOr(frame.y, args.y),
      width: numberOr(frame.width, args.width),
      height: numberOr(frame.height, args.height),
    };
  }

  async zoom(
    args: { app: AppIdentifier; x1: number; y1: number; x2: number; y2: number },
    options?: RequestOptions,
  ): Promise<{ screenshot: { url?: string | null; mimeType?: string | null } | null }> {
    const result = await this.call(
      "zoom",
      {
        ...(await this.targetArgs(args.app, false)),
        x1: args.x1,
        y1: args.y1,
        x2: args.x2,
        y2: args.y2,
      },
      options,
    );
    return { screenshot: screenshotUrl(result.structuredContent ?? {}) };
  }

  async killApp(args: { app: AppIdentifier }, options?: RequestOptions): Promise<void> {
    const resolved = await this.resolve(args.app);
    await this.call("kill_app", { pid: resolved.pid }, options);
    // The pid is gone; a cached resolution pointing at it would address nothing.
    this.resolutions.delete(args.app);
  }

  async verifyState(
    args: {
      app: AppIdentifier;
      expect: readonly unknown[];
      timeoutMs?: number;
      stableSamples?: number;
      includeScreenshot?: boolean;
    },
    options?: RequestOptions,
  ): Promise<VerifyStateResult> {
    if (args.expect.length === 0 || args.expect.length > 8) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "verify_state takes one to eight predicates, combined with AND.",
        request: args,
        requestType: "verify_state",
      });
    }
    const payload: Record<string, unknown> = {
      ...(await this.targetArgs(args.app, false)),
      expect: [...args.expect],
    };
    if (args.timeoutMs != null) payload.timeout_ms = args.timeoutMs;
    if (args.stableSamples != null) payload.stable_samples = args.stableSamples;
    if (args.includeScreenshot != null) payload.include_screenshot = args.includeScreenshot;
    const result = await this.call("verify_state", payload, options);
    const structured = result.structuredContent ?? {};
    return {
      // `unknown` is the honest default: absence of evidence is never success.
      status: typeof structured.status === "string" ? structured.status : "unknown",
      results: Array.isArray(structured.results) ? structured.results : undefined,
      screenshot: screenshotUrl(structured),
    };
  }

  async getScreenSize(options?: RequestOptions): Promise<ScreenSize> {
    const structured = (await this.call("get_screen_size", {}, options)).structuredContent ?? {};
    return {
      width: numberOr(structured.width, 0),
      height: numberOr(structured.height, 0),
      // Retina reports 2.0. Actions take points, screenshots are in pixels, so a
      // caller mixing the two without this factor clicks at half the intended spot.
      scaleFactor: numberOr(structured.scale_factor ?? structured.backing_scale_factor, 1),
    };
  }

  async getDesktopState(
    options?: RequestOptions,
  ): Promise<{ screenshot: { url?: string | null; mimeType?: string | null } | null; width?: number; height?: number }> {
    const structured = (await this.call("get_desktop_state", {}, options)).structuredContent ?? {};
    return {
      screenshot: screenshotUrl(structured),
      width: typeof structured.width === "number" ? structured.width : undefined,
      height: typeof structured.height === "number" ? structured.height : undefined,
    };
  }

  async clipboardRead(
    args: { includeText?: boolean } = {},
    options?: RequestOptions,
  ): Promise<ClipboardContents> {
    const structured = (await this.call(
      "clipboard_read",
      args.includeText ? { include_text: true } : {},
      options,
    )).structuredContent ?? {};
    const types = Array.isArray(structured.types)
      ? structured.types.filter((t): t is string => typeof t === "string")
      : [];
    return { types, text: typeof structured.text === "string" ? structured.text : undefined };
  }

  async clipboardWrite(
    args: { text?: string; imagePath?: string; filePath?: string },
    options?: RequestOptions,
  ): Promise<{ types: string[] }> {
    const payload: Record<string, unknown> = {};
    if (args.text != null) payload.text = args.text;
    if (args.imagePath != null) payload.image_path = args.imagePath;
    if (args.filePath != null) payload.file_path = args.filePath;
    // The daemon replaces the clipboard with exactly one value.
    if (Object.keys(payload).length !== 1) {
      throw new SkyComputerUseError({
        code: -32_000,
        message: "clipboard_write takes exactly one of text, imagePath or filePath.",
        request: args,
        requestType: "clipboard_write",
      });
    }
    const structured = (await this.call("clipboard_write", payload, options)).structuredContent ?? {};
    return {
      types: Array.isArray(structured.types)
        ? structured.types.filter((t): t is string => typeof t === "string")
        : [],
    };
  }

  dispose(): void {
    this.transport?.end();
    this.transport = undefined;
    this.resolutions.clear();
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * cua-driver writes the capture to a file and names it in the structured reply.
 * The exact key is not pinned by the contract, so accept the shapes it is known
 * to use and fall back to nothing rather than inventing a path.
 */
function screenshotUrl(structured: Record<string, unknown>): { url: string } | null {
  for (const key of ["screenshot_path", "screenshot_file", "screenshot_out_file", "image_path"]) {
    const value = structured[key];
    if (typeof value === "string" && value !== "") {
      return { url: value.startsWith("file:") ? value : `file://${value}` };
    }
  }
  const nested = structured.screenshot;
  if (nested != null && typeof nested === "object") {
    const path = (nested as { path?: unknown; url?: unknown }).path ?? (nested as { url?: unknown }).url;
    if (typeof path === "string" && path !== "") {
      return { url: path.startsWith("file:") ? path : `file://${path}` };
    }
  }
  return null;
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
