import { describe, expect, it } from "vitest";
import { createNodeReplFacade } from "./kernel/facade.ts";
import type { PrivilegedMethod } from "./ipc.ts";

/**
 * Trusted modules are loaded once per kernel and shared by every conversation,
 * so the façade has to give them two things to keep per-conversation state
 * straight: an identity for the conversation executing now, and a close event
 * on the connections a conversation opened when it is disposed. Without the
 * second, a client still holding such a connection — the cua-driver backend
 * after a `js_reset` — waited forever on replies that were no longer delivered.
 */
function facade() {
  let seq = 0;
  let current: object | undefined;
  const send = async (method: PrivilegedMethod) =>
    method === "nativePipe.connect" ? { connectionId: `c${seq++}` } : {};
  const f = createNodeReplFacade(send, { env: {}, requestMeta: {} }, {
    captureScope: () => current,
    runInScope: (scope, fn) => {
      const prev = current;
      current = scope as object | undefined;
      try { fn(); } finally { current = prev; }
    },
  });
  const inScope = async <T>(scope: object, fn: () => T | Promise<T>): Promise<T> => {
    current = scope;
    try { return await fn(); } finally { current = undefined; }
  };
  const nodeRepl = f.nodeRepl as typeof f.nodeRepl & { contextKey: object };
  return { ...f, nodeRepl, inScope };
}

describe("nodeRepl.contextKey", () => {
  it("is stable within a conversation and distinct across conversations", async () => {
    const { nodeRepl, inScope } = facade();
    const a = {};
    const b = {};
    const a1 = await inScope(a, () => nodeRepl.contextKey);
    const a2 = await inScope(a, () => nodeRepl.contextKey);
    const b1 = await inScope(b, () => nodeRepl.contextKey);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it("does not hand out the scope itself, so one module cannot reach another conversation", async () => {
    const { nodeRepl, inScope } = facade();
    const scope = { sandbox: { secret: 1 } };
    const key = await inScope(scope, () => nodeRepl.contextKey);
    expect(key).not.toBe(scope);
    expect(Object.keys(key)).toEqual([]);
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("is not exposed to model code", () => {
    const { untrustedNodeRepl } = facade();
    expect("contextKey" in untrustedNodeRepl).toBe(false);
  });
});

describe("disposing a conversation", () => {
  it("fires close on the connections it opened, so their clients stop waiting", async () => {
    const { nodeRepl, dispatchConnectionEvent, forgetConnectionsInScope, inScope } = facade();
    const ctxA = {};
    const conn = await inScope(ctxA, () => nodeRepl.nativePipe.createConnection("/sock"));
    let closed = 0;
    const got: string[] = [];
    conn.on("close", () => { closed += 1; });
    conn.on("data", (chunk) => got.push(Buffer.from(chunk as Uint8Array).toString()));

    expect(forgetConnectionsInScope(ctxA)).toEqual(["c0"]);
    expect(closed).toBe(1);
    // Nothing arrives after teardown.
    dispatchConnectionEvent({
      event: "nativePipe.data",
      connectionId: "c0",
      dataBase64: Buffer.from("late").toString("base64"),
    });
    expect(got).toEqual([]);
  });

  it("leaves other conversations' connections alone", async () => {
    const { nodeRepl, forgetConnectionsInScope, inScope } = facade();
    const ctxA = {};
    const ctxB = {};
    await inScope(ctxA, () => nodeRepl.nativePipe.createConnection("/sock"));
    const connB = await inScope(ctxB, () => nodeRepl.nativePipe.createConnection("/sock"));
    let closedB = 0;
    connB.on("close", () => { closedB += 1; });

    forgetConnectionsInScope(ctxA);
    expect(closedB).toBe(0);
  });

  it("drops the after-code hooks it registered", async () => {
    const { nodeRepl, forgetHooksInScope, runAfterSubmittedCodeHooks, inScope } = facade();
    const ctxA = {};
    let runs = 0;
    await inScope(ctxA, () => nodeRepl.addAfterSubmittedCodeHook({ run: () => { runs += 1; } }));
    await runAfterSubmittedCodeHooks(ctxA);
    expect(runs).toBe(1);
    forgetHooksInScope(ctxA);
    await runAfterSubmittedCodeHooks();
    expect(runs).toBe(1);
  });
});
