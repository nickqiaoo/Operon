import { describe, expect, it, vi } from "vitest";
import { CuaDaemonTransport } from "./daemon.ts";
import { CuaDriverBackend } from "./backend.ts";
import type { NativePipeConnection } from "../wire.ts";

/** A NativePipeConnection whose peer is a scripted responder. */
function fakeSocket() {
  const listeners: { data: Array<(c: Uint8Array) => void>; error: Array<(e: Error) => void>; close: Array<() => void> } =
    { data: [], error: [], close: [] };
  const written: string[] = [];
  let ended = false;
  const socket: NativePipeConnection = {
    write(data: Uint8Array) { written.push(Buffer.from(data).toString("utf8")); },
    end() { ended = true; },
    on(event: "data" | "error" | "close", listener: never) {
      (listeners[event] as Array<unknown>).push(listener);
    },
  } as NativePipeConnection;
  return {
    socket,
    written,
    get ended() { return ended; },
    /** Deliver bytes as if the daemon sent them; `raw` may split lines anywhere. */
    feed(raw: string) { for (const l of listeners.data) l(Buffer.from(raw, "utf8")); },
    reply(obj: unknown) { this.feed(`${JSON.stringify(obj)}\n`); },
    fail(message: string) { for (const l of listeners.error) l(new Error(message)); },
  };
}

describe("CuaDaemonTransport", () => {
  it("frames requests as one JSON line each", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.send({ method: "metadata" });
    expect(peer.written).toEqual(['{"method":"metadata"}\n']);
    peer.reply({ ok: true, result: { driver_version: "0.23.2" } });
    await expect(call).resolves.toMatchObject({ ok: true });
  });

  it("matches replies in send order, because the protocol has no request ids", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const first = t.send({ method: "call", name: "one" });
    const second = t.send({ method: "call", name: "two" });
    peer.reply({ ok: true, result: "first" });
    peer.reply({ ok: true, result: "second" });
    expect((await first).result).toBe("first");
    expect((await second).result).toBe("second");
  });

  it("reassembles a reply split across chunks", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.send({ method: "metadata" });
    peer.feed('{"ok":true,"resu');
    peer.feed('lt":{"a":1}}\n');
    expect((await call).result).toEqual({ a: 1 });
  });

  it("splits two replies delivered in one chunk", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const a = t.send({ method: "call", name: "a" });
    const b = t.send({ method: "call", name: "b" });
    peer.feed('{"ok":true,"result":1}\n{"ok":true,"result":2}\n');
    expect((await a).result).toBe(1);
    expect((await b).result).toBe(2);
  });

  it("a timeout poisons the connection instead of rejecting one call", async () => {
    vi.useFakeTimers();
    try {
      const peer = fakeSocket();
      const t = new CuaDaemonTransport(peer.socket);
      const first = t.send({ method: "call", name: "slow" }, 1000);
      const settled = expect(first).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(1001);
      await settled;
      // Ordered matching means a late reply would land on the next caller, so
      // the whole connection has to go.
      expect(t.isClosed).toBe(true);
      expect(peer.ended).toBe(true);
      await expect(t.send({ method: "metadata" })).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a refused envelope into an error carrying the driver's message", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.call("click", { pid: 1 });
    peer.reply({ ok: false, error: "Background scroll is unavailable", exit_code: 1 });
    await expect(call).rejects.toThrow(/Background scroll is unavailable/);
  });

  it("revives an idle-ended session and retries the call once", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.call("list_apps", {});
    const ended = {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: "this session has ended; call start_session explicitly to reuse its label" }],
        structuredContent: { refusal: { code: "session_ended" }, status: "refused" },
      },
    };
    peer.reply(ended);
    await vi.waitFor(() => expect(peer.written).toHaveLength(2));
    expect(JSON.parse(peer.written[1]!)).toEqual({ method: "call", name: "start_session", args: {} });
    peer.reply({ ok: true, result: { structuredContent: { active: true, revived: true } } });
    await vi.waitFor(() => expect(peer.written).toHaveLength(3));
    expect(JSON.parse(peer.written[2]!)).toMatchObject({ method: "call", name: "list_apps" });
    peer.reply({ ok: true, result: { structuredContent: { apps: [] } } });
    await expect(call).resolves.toMatchObject({ structuredContent: { apps: [] } });
  });

  it("revives a named session by its label, and gives up after one retry", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket, { session: "run-1" });
    const call = t.call("click", { pid: 1 });
    const ended = {
      ok: true,
      result: {
        isError: true,
        content: [{ type: "text", text: "this session has ended" }],
        structuredContent: { refusal: { code: "session_ended" } },
      },
    };
    peer.reply(ended);
    await vi.waitFor(() => expect(peer.written).toHaveLength(2));
    expect(JSON.parse(peer.written[1]!)).toEqual({ method: "call", name: "start_session", args: { session: "run-1" } });
    peer.reply({ ok: true, result: {} });
    await vi.waitFor(() => expect(peer.written).toHaveLength(3));
    peer.reply(ended);
    await expect(call).rejects.toThrow(/session has ended/);
    expect(peer.written).toHaveLength(3);
  });

  it("treats an isError tool result as a failure, not a value", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.call("get_window_state", {});
    peer.reply({ ok: true, result: { isError: true, content: [{ type: "text", text: "Missing window_id" }] } });
    await expect(call).rejects.toThrow(/Missing window_id/);
  });
});

describe("CuaDriverBackend.renderTree", () => {
  const MARKDOWN = [
    '- [0] AXWindow "Fixture" [actions=[raise]]',
    "  - [1] AXOutline (Sidebar)",
    "    - [2] AXRow [actions=[showdefaultui]]",
    '      - AXStaticText = "Recents"',
    "    - [3] AXRow [actions=[showdefaultui]]",
  ].join("\n");

  it("passes the markdown through untouched when nothing is selected", () => {
    expect(CuaDriverBackend.renderTree(MARKDOWN, [{ element_index: 2 }, { element_index: 3, selected: false }]))
      .toBe(MARKDOWN);
  });

  it("marks a selected row after its role, and leaves the text rows alone", () => {
    const lines = CuaDriverBackend.renderTree(MARKDOWN, [{ element_index: 2, selected: true }]).split("\n");
    expect(lines[2]).toBe("    - [2] AXRow (selected) [actions=[showdefaultui]]");
    expect(lines[3]).toBe('      - AXStaticText = "Recents"');
    expect(lines[4]).toBe("    - [3] AXRow [actions=[showdefaultui]]");
  });

  it("keeps the mark on the row when its label runs over several lines", () => {
    const multiline = '- [4] AXButton "first\nsecond" [actions=[press]]';
    expect(CuaDriverBackend.renderTree(multiline, [{ element_index: 4, selected: true }]))
      .toBe('- [4] AXButton (selected) "first\nsecond" [actions=[press]]');
  });

  it("ignores a selected element the markdown does not show", () => {
    expect(CuaDriverBackend.renderTree(MARKDOWN, [{ element_index: 99, selected: true }])).toBe(MARKDOWN);
  });
});

describe("CuaDriverBackend.renderTreeNotes", () => {
  it("adds nothing for a capped walk, which the markdown already reports", () => {
    expect(CuaDriverBackend.renderTreeNotes({
      returned_element_count: 111,
      total_element_count: 111,
      truncated: true,
      elements_complete: false,
    })).toBe("");
  });

  it("warns about a refused input route before an action tries to use it", () => {
    const notes = CuaDriverBackend.renderTreeNotes({
      background_input: {
        routes: [
          { route: "accessibility", status: "available" },
          { route: "pid_keyboard", status: "refused", reason: "same_pid_keyboard_ambiguity" },
        ],
      },
    });
    expect(notes).toContain("pid_keyboard");
    expect(notes).toContain("same_pid_keyboard_ambiguity");
  });

  it("says how much of the window a query matched", () => {
    const notes = CuaDriverBackend.renderTreeNotes(
      { returned_element_count: 11, total_element_count: 246, elements_complete: false },
      true,
    );
    expect(notes).toBe("[query matched 11 of 246 elements]");
  });

  it("stays empty for an ordinary tree, so no preamble is added", () => {
    expect(CuaDriverBackend.renderTreeNotes({
      returned_element_count: 10,
      total_element_count: 10,
      elements_complete: false,
    })).toBe("");
  });
});

/** Backend wired to a scripted daemon, so policy and mapping can be tested
 *  without a desktop. */
function backendWith(
  script: (name: string, args: Record<string, unknown>) => unknown,
  image?: { data: string; mimeType: string },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const peer = fakeSocket();
  const backend = new CuaDriverBackend({
    socketPath: "/unused",
    connect: async () => peer.socket,
  });
  // Answer every request the moment it is written.
  const originalWrite = peer.socket.write.bind(peer.socket);
  (peer.socket as { write: (d: Uint8Array) => void }).write = (data: Uint8Array) => {
    originalWrite(data);
    const request = JSON.parse(Buffer.from(data).toString("utf8"));
    queueMicrotask(() => {
      if (request.method === "metadata" || request.method === "session_begin") {
        peer.reply({ ok: true, result: {} });
        return;
      }
      calls.push({ name: request.name, args: request.args });
      peer.reply({
        ok: true,
        result: {
          structuredContent: script(request.name, request.args),
          ...(request.name === "get_window_state" && image ? { content: [{ type: "image", ...image }] } : {}),
        },
      });
    });
  };
  return { backend, calls };
}

/**
 * Shaped after a real `list_apps` reply: every *installed* app is listed, and a
 * running one carries a live `pid`. Resolution depends on that distinction, so
 * a fixture that omitted `pid` would test a world the daemon never produces.
 */
const APPS = {
  apps: [
    {
      bundle_id: "com.apple.calculator", name: "Calculator",
      launch_path: "/System/Applications/Calculator.app",
      active: false, running: true, pid: 42,
    },
    { bundle_id: "com.1password.1password", name: "1Password", launch_path: "/Applications/1Password.app", running: false, pid: 0 },
  ],
};
const WINDOWS = {
  windows: [
    { app_name: "Calculator", pid: 42, window_id: 7, title: "Calculator", is_on_screen: true, layer: 0, z_index: 1 },
  ],
};

describe("CuaDriverBackend policy", () => {
  it("allows an ordinary app and reports its canonical identity", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    const policy = await backend.getAppPolicy("com.apple.calculator");
    expect(policy.decision).toBe("allowed");
    expect(policy.allowPersistentApproval).toBe(true);
    expect(policy.target).toMatchObject({
      bundleIdentifier: "com.apple.calculator",
      displayName: "Calculator",
      appPath: "/System/Applications/Calculator.app",
      risk: "low",
    });
  });

  it("forbids a password manager, matching the Swift engine's block list", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    const policy = await backend.getAppPolicy("com.1password.1password");
    expect(policy.decision).toBe("forbidden");
    expect(policy.allowPersistentApproval).toBe(false);
    expect(policy.target.risk).toBe("high");
  });

  it("resolves an app by name and by path, not only by bundle id", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(backend.getAppPolicy("Calculator")).resolves.toMatchObject({ decision: "allowed" });
    await expect(backend.getAppPolicy("/System/Applications/Calculator.app"))
      .resolves.toMatchObject({ decision: "allowed" });
  });

  it("refuses an app it cannot find rather than inventing an identity", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(backend.getAppPolicy("/Applications/Nope.app")).rejects.toThrow(/could not find/i);
  });
});

describe("CuaDriverBackend app resolution", () => {
  /** A running app with no window of its own, plus another app that does have
   *  one — the shape that produced the original bug. */
  const OTHER_WINDOW = {
    windows: [
      { app_name: "OrbStack", pid: 99, window_id: 3, is_on_screen: true, layer: 0, z_index: 1 },
    ],
  };

  it("never addresses another app's window when the target has none", async () => {
    // The first version fell back to the frontmost window of any app, so asking
    // for a closed System Settings silently drove whatever was in front.
    const { backend, calls } = backendWith((name, args) => {
      if (name === "list_apps") return APPS;
      if (name === "launch_app") return { app: { pid: 0, windows: [] } };
      // Never any window for pid 42; only the unrelated app has one.
      return (args as { pid?: number }).pid === 99 ? OTHER_WINDOW : { windows: [] };
    });
    await expect(backend.getAppState({ app: "Calculator" })).rejects.toThrow(/no window/i);
    expect(calls.some((c) => c.name === "click" || c.name === "get_window_state")).toBe(false);
  });

  it("launches an installed app that is not running, like the Swift engine does", async () => {
    let launched = false;
    const { backend, calls } = backendWith((name, args) => {
      if (name === "list_apps") {
        return {
          apps: [{
            bundle_id: "com.apple.calculator", name: "Calculator",
            launch_path: "/System/Applications/Calculator.app",
            running: launched, pid: launched ? 42 : 0,
          }],
        };
      }
      if (name === "launch_app") {
        launched = true;
        return { app: { pid: 42, name: "计算器", windows: WINDOWS.windows } };
      }
      if (name === "list_windows") return (args as { pid?: number }).pid === 42 ? WINDOWS : { windows: [] };
      return { elements: [], snapshot_id: "s1" };
    });
    const state = await backend.getAppState({ app: "Calculator" });
    expect(calls.find((c) => c.name === "launch_app")?.args)
      .toMatchObject({ bundle_id: "com.apple.calculator" });
    expect(state.app).toMatchObject({ bundleIdentifier: "com.apple.calculator", pid: 42 });
  });

  it("matches a running app by its bundle name when the display name is localized", async () => {
    // A running System Settings reports "系统设置" on a Chinese Mac. Matching only
    // on `name` made an English request resolve while closed and fail once open.
    const { backend } = backendWith((name, args) => {
      if (name === "list_apps") {
        return {
          apps: [{
            bundle_id: "com.apple.systempreferences", name: "系统设置",
            launch_path: "/System/Applications/System Settings.app",
            running: true, pid: 42,
          }],
        };
      }
      if (name === "list_windows") return (args as { pid?: number }).pid === 42 ? WINDOWS : { windows: [] };
      return { elements: [], snapshot_id: "s1" };
    });
    const state = await backend.getAppState({ app: "System Settings" });
    expect(state.app).toMatchObject({ bundleIdentifier: "com.apple.systempreferences", pid: 42 });
  });

  it("matches a system app with no launch path by its bundle id's last segment", async () => {
    // Finder reports a localized name and no launch_path at all.
    const { backend } = backendWith((name, args) => {
      if (name === "list_apps") {
        return { apps: [{ bundle_id: "com.apple.finder", name: "访达", launch_path: null, running: true, pid: 42 }] };
      }
      if (name === "list_windows") return (args as { pid?: number }).pid === 42 ? WINDOWS : { windows: [] };
      return { elements: [], snapshot_id: "s1" };
    });
    await expect(backend.getAppState({ app: "Finder" })).resolves.toMatchObject({
      app: { bundleIdentifier: "com.apple.finder" },
    });
  });
});

/** A daemon that resolves the app and answers every other call with a snapshot. */
function withSnapshot(name: string): unknown {
  if (name === "list_apps") return APPS;
  if (name === "list_windows") return WINDOWS;
  return { snapshot_id: "s00000001", elements: [] };
}

describe("CuaDriverBackend action mapping", () => {
  it("addresses the resolved window's pid and passes the element as a token", async () => {
    const { backend, calls } = backendWith(withSnapshot);
    await backend.click({ app: "com.apple.calculator", elementIndex: 3 });
    const click = calls.find((c) => c.name === "click");
    expect(click?.args).toMatchObject({ pid: 42, element_token: "s00000001:3", button: "left", count: 1 });
  });

  it("passes an AX action straight through to click, no translation table", async () => {
    for (const action of ["press", "show_menu", "pick", "confirm", "cancel", "open"] as const) {
      const { backend, calls } = backendWith(withSnapshot);
      await backend.click({ app: "Calculator", elementIndex: 1, action });
      expect(calls.find((c) => c.name === "click")?.args).toMatchObject({ action });
    }
  });

  it("refuses an AX action addressed by coordinates, which the daemon cannot honour", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(
      backend.click({ app: "Calculator", x: 10, y: 10, action: "show_menu" }),
    ).rejects.toThrow(/requires element_index/);
    expect(calls.some((c) => c.name === "click")).toBe(false);
  });

  it("raises a window through bring_to_front, its own method now", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await backend.bringToFront({ app: "Calculator" });
    expect(calls.some((c) => c.name === "click")).toBe(false);
    expect(calls.find((c) => c.name === "bring_to_front")?.args).toMatchObject({ pid: 42, window_id: 7 });
  });

  it("normalises mouse buttons and scroll directions to the driver's spelling", async () => {
    const { backend, calls } = backendWith(withSnapshot);
    await backend.click({ app: "Calculator", elementIndex: 1, mouseButton: "r" });
    await backend.scroll({ app: "Calculator", direction: "d", elementIndex: 1, pages: 2 });
    expect(calls.find((c) => c.name === "click")?.args).toMatchObject({ button: "right" });
    expect(calls.find((c) => c.name === "scroll")?.args).toMatchObject({ direction: "down", amount: 2, by: "page" });
  });

  it("rejects a click with neither an element nor a point", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(backend.click({ app: "Calculator" })).rejects.toThrow(/element_index or x and y/);
  });

  it("carries the snapshot in the token on element-indexed actions", async () => {
    // The driver refuses a token from a superseded snapshot. That refusal is what
    // stands in for the automatic intervention detection this migration drops.
    const { backend, calls } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return { snapshot_id: "sdeadbeef", elements: [{ element_index: 0, role: "AXWindow" }] };
    });
    await backend.getAppState({ app: "Calculator" });
    await backend.click({ app: "Calculator", elementIndex: 2 });
    expect(calls.find((c) => c.name === "click")?.args).toMatchObject({
      pid: 42,
      window_id: 7,
      element_token: "sdeadbeef:2",
    });
  });

  it("sends only the token: the driver rejects element_index and snapshot_id as unknown", async () => {
    const { backend, calls } = backendWith(withSnapshot);
    await backend.click({ app: "Calculator", elementIndex: 1 });
    await backend.scroll({ app: "Calculator", direction: "d", elementIndex: 1 });
    await backend.setValue({ app: "Calculator", elementIndex: 1, value: "x" });
    await backend.hotkey({ app: "Calculator", keys: ["cmd", "c"], elementIndex: 1 });
    await backend.doubleClick({ app: "Calculator", elementIndex: 1 });
    await backend.rightClick({ app: "Calculator", elementIndex: 1 });
    for (const name of ["click", "scroll", "set_value", "hotkey", "double_click", "right_click"]) {
      const args = calls.find((c) => c.name === name)?.args;
      expect(args, name).toHaveProperty("element_token");
      expect(args, name).not.toHaveProperty("element_index");
      expect(args, name).not.toHaveProperty("snapshot_id");
    }
  });

  it("refuses an element action when the window yields no snapshot to address it in", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(backend.click({ app: "Calculator", elementIndex: 1 })).rejects.toThrow(/no snapshot/);
    expect(calls.some((c) => c.name === "click")).toBe(false);
  });

  it("asks for both tree formats and the input route report", async () => {
    const { backend, calls } = backendWith(withSnapshot);
    await backend.getAppState({ app: "Calculator" });
    expect(calls.find((c) => c.name === "get_window_state")?.args)
      .toMatchObject({ tree_format: "both", verbose: true });
  });

  it("takes a snapshot first when an element action arrives without one", async () => {
    const { backend, calls } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return { snapshot_id: "s00000001", elements: [] };
    });
    await backend.setValue({ app: "Calculator", elementIndex: 1, value: "x" });
    // Mirrors the Swift engine's currentSnapshot: an action that follows no
    // explicit get_app_state still works.
    expect(calls.map((c) => c.name)).toContain("get_window_state");
    expect(calls.find((c) => c.name === "set_value")?.args).toMatchObject({ element_token: "s00000001:1" });
  });

  it("drops the snapshot after an action, because the index map is now stale", async () => {
    let snapshots = 0;
    const { backend, calls } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      if (name !== "get_window_state") return {};
      snapshots += 1;
      return { snapshot_id: `s0000000${snapshots}`, elements: [] };
    });
    await backend.getAppState({ app: "Calculator" });
    await backend.click({ app: "Calculator", elementIndex: 1 });
    await backend.click({ app: "Calculator", elementIndex: 1 });
    const clicks = calls.filter((c) => c.name === "click");
    expect(clicks[0]?.args).toMatchObject({ element_token: "s00000001:1" });
    // The second click re-snapshotted rather than reusing a map the first click
    // invalidated.
    expect(clicks[1]?.args).toMatchObject({ element_token: "s00000002:1" });
  });

  it("does not attach a snapshot to a coordinate action", async () => {
    const { backend, calls } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return { snapshot_id: "sabcdef01", elements: [] };
    });
    await backend.click({ app: "Calculator", x: 10, y: 20 });
    const click = calls.find((c) => c.name === "click");
    expect(click?.args).toMatchObject({ x: 10, y: 20, window_id: 7 });
    expect(click?.args).not.toHaveProperty("element_token");
    // A pixel click needs no index map, so it must not trigger a tree walk.
    expect(calls.some((c) => c.name === "get_window_state")).toBe(false);
  });

  it("addresses a window, not just a process", async () => {
    const { backend, calls } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return { snapshot_id: "s11111111", elements: [] };
    });
    await backend.pressKey({ app: "Calculator", key: "a" });
    await backend.typeText({ app: "Calculator", text: "hi" });
    await backend.drag({ app: "Calculator", fromX: 1, fromY: 2, toX: 3, toY: 4 });
    for (const name of ["press_key", "type_text", "drag"]) {
      expect(calls.find((c) => c.name === name)?.args, name).toMatchObject({ pid: 42, window_id: 7 });
    }
  });

  it("reads the screenshot path from whichever key the driver used", async () => {
    for (const structured of [
      { screenshot_file_path: "/tmp/a.png" },
      { screenshot_path: "/tmp/a.png" },
      { screenshot_file: "/tmp/a.png" },
      { screenshot: { path: "/tmp/a.png" } },
      { screenshot: { url: "file:///tmp/a.png" } },
    ]) {
      const { backend } = backendWith((name) => {
        if (name === "list_apps") return APPS;
        if (name === "list_windows") return WINDOWS;
        return { elements: [], ...structured };
      });
      const state = await backend.getAppState({ app: "Calculator" });
      expect(state.skyshot?.screenshot?.url).toBe("file:///tmp/a.png");
    }
  });

  it("reads the driver's default inline screenshot image", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { backend, calls } = backendWith(
      (name) => {
        if (name === "list_apps") return APPS;
        if (name === "list_windows") return WINDOWS;
        return { elements: [], screenshot_width: 1, screenshot_height: 1 };
      },
      { data: png, mimeType: "image/png" },
    );
    const state = await backend.getAppState({ app: "Calculator" });
    expect(state.skyshot?.screenshot?.url).toBe(`data:image/png;base64,${png}`);
    expect(calls.find((call) => call.name === "get_window_state")?.args).toMatchObject({ include_screenshot: true });
  });

  it("gives the model the markdown, with selection filled in from the elements", async () => {
    const { backend } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return {
        elements: [
          { element_index: 0, role: "AXWindow", label: "Calculator", depth: 0 },
          { element_index: 1, role: "AXButton", label: "5", depth: 1, selected: true },
        ],
        tree_markdown: '- [0] AXWindow "Calculator"\n  - [1] AXButton "5" [actions=[press]]',
      };
    });
    const state = await backend.getAppState({ app: "Calculator" });
    expect(state.skyshot?.text).toBe('- [0] AXWindow "Calculator"\n  - [1] AXButton (selected) "5" [actions=[press]]');
    expect(state.app).toMatchObject({ bundleIdentifier: "com.apple.calculator", pid: 42 });
  });
});
