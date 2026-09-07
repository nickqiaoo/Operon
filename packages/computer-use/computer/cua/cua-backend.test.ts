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

  it("treats an isError tool result as a failure, not a value", async () => {
    const peer = fakeSocket();
    const t = new CuaDaemonTransport(peer.socket);
    const call = t.call("get_window_state", {});
    peer.reply({ ok: true, result: { isError: true, content: [{ type: "text", text: "Missing window_id" }] } });
    await expect(call).rejects.toThrow(/Missing window_id/);
  });
});

describe("CuaDriverBackend.renderTree", () => {
  it("puts element_index first so existing row parsing keeps working", () => {
    const text = CuaDriverBackend.renderTree([
      { element_index: 0, role: "AXWindow", label: "Fixture", depth: 0 },
      { element_index: 1, role: "AXButton", label: "Increment", depth: 1 },
      { element_index: 2, role: "AXTextField", label: "Input", value: "hi", depth: 2 },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("0 AXWindow Fixture");
    expect(lines[1]).toBe("\t1 AXButton Increment");
    expect(lines[2]).toBe("\t\t2 AXTextField Input hi");
    // The row shape the fixture suites parse.
    expect((text.match(/^\s*\d+\s/gm) ?? []).length).toBe(3);
  });

  it("drops rows with no element_index, which are not addressable", () => {
    const text = CuaDriverBackend.renderTree([
      { element_index: 0, role: "AXWindow" },
      { role: "AXGroup" },
    ]);
    expect(text.split("\n")).toHaveLength(1);
  });
});

/** Backend wired to a scripted daemon, so policy and mapping can be tested
 *  without a desktop. */
function backendWith(script: (name: string, args: Record<string, unknown>) => unknown) {
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
      peer.reply({ ok: true, result: { structuredContent: script(request.name, request.args) } });
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

describe("CuaDriverBackend action mapping", () => {
  it("addresses the resolved window's pid and passes element_index through", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await backend.click({ app: "com.apple.calculator", elementIndex: 3 });
    const click = calls.find((c) => c.name === "click");
    expect(click?.args).toMatchObject({ pid: 42, element_index: 3, button: "left", count: 1 });
  });

  it("maps the six click-shaped secondary actions onto click's action parameter", async () => {
    for (const [given, expected] of [
      ["Press", "press"], ["AXShowMenu", "show_menu"], ["pick", "pick"],
      ["confirm", "confirm"], ["Cancel", "cancel"], ["AXOpen", "open"],
    ] as const) {
      const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
      await backend.performSecondaryAction({ app: "Calculator", action: given, elementIndex: 1 });
      expect(calls.find((c) => c.name === "click")?.args).toMatchObject({ action: expected });
    }
  });

  it("sends Raise to bring_to_front, which is where AXRaise actually lives", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await backend.performSecondaryAction({ app: "Calculator", action: "AXRaise", elementIndex: 1 });
    expect(calls.some((c) => c.name === "click")).toBe(false);
    expect(calls.find((c) => c.name === "bring_to_front")?.args).toMatchObject({ pid: 42, window_id: 7 });
  });

  it("refuses an unknown secondary action instead of letting it become a click", async () => {
    // cua-driver's map_action ends in `_ => "AXPress"`. Forwarding AXDecrement
    // would silently click a stepper instead of decrementing it, and report success.
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(
      backend.performSecondaryAction({ app: "Calculator", action: "AXDecrement", elementIndex: 1 }),
    ).rejects.toThrow(/cannot perform the secondary action/i);
    expect(calls.some((c) => c.name === "click")).toBe(false);
  });

  it("normalises mouse buttons and scroll directions to the driver's spelling", async () => {
    const { backend, calls } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await backend.click({ app: "Calculator", elementIndex: 1, mouseButton: "r" });
    await backend.scroll({ app: "Calculator", direction: "d", elementIndex: 1, pages: 2 });
    expect(calls.find((c) => c.name === "click")?.args).toMatchObject({ button: "right" });
    expect(calls.find((c) => c.name === "scroll")?.args).toMatchObject({ direction: "down", amount: 2, by: "page" });
  });

  it("rejects a click with neither an element nor a point", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(backend.click({ app: "Calculator" })).rejects.toThrow(/element_index or x and y/);
  });

  it("says plainly that select_text has no equivalent yet", async () => {
    const { backend } = backendWith((name) => (name === "list_apps" ? APPS : WINDOWS));
    await expect(
      backend.selectText({ app: "Calculator", elementIndex: 1, text: "hi" }),
    ).rejects.toThrow(/no cua-driver equivalent/);
  });

  it("carries the snapshot handle on element-indexed actions", async () => {
    // The driver's contract: "required when targeting by element_index; stale
    // snapshots fail closed". That refusal is what stands in for the automatic
    // intervention detection this migration drops.
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
      element_index: 2,
      snapshot_id: "sdeadbeef",
    });
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
    expect(calls.find((c) => c.name === "set_value")?.args).toMatchObject({ snapshot_id: "s00000001" });
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
    expect(clicks[0]?.args).toMatchObject({ snapshot_id: "s00000001" });
    // The second click re-snapshotted rather than reusing a map the first click
    // invalidated.
    expect(clicks[1]?.args).toMatchObject({ snapshot_id: "s00000002" });
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
    expect(click?.args).not.toHaveProperty("snapshot_id");
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

  it("builds app state from the structured elements, not their markdown", async () => {
    const { backend } = backendWith((name) => {
      if (name === "list_apps") return APPS;
      if (name === "list_windows") return WINDOWS;
      return {
        elements: [
          { element_index: 0, role: "AXWindow", label: "Calculator", depth: 0 },
          { element_index: 1, role: "AXButton", label: "5", depth: 1 },
        ],
        tree_markdown: "should not be used",
      };
    });
    const state = await backend.getAppState({ app: "Calculator" });
    expect(state.skyshot?.text).toBe("0 AXWindow Calculator\n\t1 AXButton 5");
    expect(state.app).toMatchObject({ bundleIdentifier: "com.apple.calculator", pid: 42 });
  });
});
