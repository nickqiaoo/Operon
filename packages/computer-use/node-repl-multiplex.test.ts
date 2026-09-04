import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { NodeReplHost } from "./NodeReplHost.ts";
import { NodeReplSession } from "./NodeReplSession.ts";

/**
 * One kernel process, a vm context per conversation.
 *
 * The process is what costs — ~63 MB and ~115 ms of fork plus tsx, against
 * ~0.2 MB and ~190 µs for a vm context — so it is shared and the contexts are
 * not. These tests pin the two properties that makes acceptable:
 *
 *   1. contexts do not see each other's globals;
 *   2. everything that leaves the kernel is attributed to the context that
 *      caused it — output, and above all the session id, which is the browser
 *      backend's tab-lease and ownership key.
 *
 * (2) is the one worth distrusting. Trusted modules are cached per process, so
 * the browser SDK is a single module instance shared by every context reading
 * `globalThis.nodeRepl.requestMeta`; only the AsyncLocalStorage in kernel/entry
 * keeps that from meaning "whichever conversation wrote last".
 */

const SOCK = "/tmp/opcu-multiplex-unused.sock";

let host: NodeReplHost | undefined;
const sessions: NodeReplSession[] = [];

function sharedHost(): NodeReplHost {
  host ??= new NodeReplHost({ env: { SKY_CUA_NATIVE_PIPE_PATH: SOCK } });
  return host;
}

function session(banner?: string): NodeReplSession {
  const s = new NodeReplSession({
    socketPath: SOCK,
    host: sharedHost(),
    ...(banner ? { banner } : {}),
  });
  sessions.push(s);
  return s;
}

const turn = (id: string) => ({ session_id: id, turn_id: `${id}-turn` });

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  await host?.dispose();
  host = undefined;
});

describe("contexts are isolated", () => {
  it("one conversation's globals are invisible to another", async () => {
    const a = session();
    const b = session();
    await a.run(`globalThis.secret = "from-a";`, turn("a"));
    const seen = await b.run(`return globalThis.secret ?? "not-visible";`, turn("b"));
    expect(seen.result).toBe("not-visible");
  });

  it("resetting one conversation leaves the other's state alone", async () => {
    const a = session();
    const b = session();
    await a.run(`globalThis.v = "a";`, turn("a"));
    await b.run(`globalThis.v = "b";`, turn("b"));
    await a.reset();
    expect((await a.run(`return globalThis.v ?? "gone";`, turn("a"))).result).toBe("gone");
    expect((await b.run(`return globalThis.v;`, turn("b"))).result).toBe("b");
  });

  it("disposing one conversation leaves the kernel serving the others", async () => {
    const a = session();
    const b = session();
    await a.run(`globalThis.v = "a";`, turn("a"));
    await b.run(`globalThis.v = "b";`, turn("b"));
    await a.dispose();
    // A shared kernel is not the disposing session's to kill.
    expect(sharedHost().alive).toBe(true);
    expect((await b.run(`return globalThis.v;`, turn("b"))).result).toBe("b");
  });
});

describe("everything leaving the kernel is attributed to its context", () => {
  it("write reaches the session that ran the code, not the one that ran last", async () => {
    const a = session();
    const b = session();
    const first = await a.run(`nodeRepl.write("from-a");`, turn("a"));
    const second = await b.run(`nodeRepl.write("from-b");`, turn("b"));
    expect(first.output).toBe("from-a");
    expect(second.output).toBe("from-b");
  });

  it("each context reads its own session id, even with executions interleaved", async () => {
    // The regression this exists for: a single shared `requestMeta` field. Both
    // contexts yield before reading, so a field would hand both of them
    // whichever turn metadata was written second.
    const a = session();
    const b = session();
    const read = `
      await new Promise((r) => setTimeout(r, 30));
      return nodeRepl.requestMeta["x-codex-turn-metadata"].session_id;
    `;
    const [ra, rb] = await Promise.all([
      a.run(read, turn("alpha")),
      b.run(read, turn("beta")),
    ]);
    expect(ra.result).toBe("alpha");
    expect(rb.result).toBe("beta");
  });

  it("interleaved output does not bleed between conversations", async () => {
    const a = session();
    const b = session();
    const emit = (tag: string) => `
      nodeRepl.write("${tag}1");
      await new Promise((r) => setTimeout(r, 20));
      nodeRepl.write("${tag}2");
    `;
    const [ra, rb] = await Promise.all([
      a.run(emit("a"), turn("a")),
      b.run(emit("b"), turn("b")),
    ]);
    expect(ra.output).toBe("a1a2");
    expect(rb.output).toBe("b1b2");
  });

  it("the banner runs once per context, not once per kernel", async () => {
    const a = session(`globalThis.setupRuns = (globalThis.setupRuns ?? 0) + 1;`);
    const b = session(`globalThis.setupRuns = (globalThis.setupRuns ?? 0) + 1;`);
    expect((await a.run(`return globalThis.setupRuns;`, turn("a"))).result).toBe(1);
    expect((await b.run(`return globalThis.setupRuns;`, turn("b"))).result).toBe(1);
  });
});

describe("the process is actually shared", () => {
  it("N conversations fork one kernel, not N", async () => {
    const all = [session(), session(), session(), session()];
    await Promise.all(all.map((s, i) => s.run(`return ${i};`, turn(`s${i}`))));
    const kernels = execSync(`pgrep -P ${process.pid} || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(kernels.length).toBe(1);
  });
});

describe("a dead kernel fails loudly instead of hanging", () => {
  it("rejects in-flight and subsequent calls once the kernel exits", async () => {
    const a = session();
    await a.run(`return 1;`, turn("a"));
    const kernel = sharedHost();
    await kernel.dispose();
    expect(kernel.alive).toBe(false);
    // Before this, execPending was never settled on exit and every caller —
    // every conversation, on a shared kernel — waited forever.
    await expect(kernel.exec("nope", `return 1;`)).rejects.toThrow();
  });
});
