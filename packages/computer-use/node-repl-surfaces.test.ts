import { describe, expect, it } from "vitest";
import { NodeReplSession } from "./NodeReplSession.ts";
import { buildNodeReplBanner } from "./banner.ts";
import { buildNodeReplToolDescription, clampNodeReplOutput } from "./adapters/tool.ts";

/**
 * node_repl is mounted when *any* of Computer Use, Browser Use or Chrome is on,
 * but the kernel only has the globals for the ones that are. Two things have to
 * follow from the same surface list or the model is lied to:
 *
 *   - the `js` description, which used to be a compile-time constant promising
 *     `computer.*` even in a browser-only session;
 *   - the banner, which installs the runtimes the description promises.
 */

const SOCK = "/tmp/opcu-surfaces-unused.sock";

describe("the js description follows the enabled surfaces", () => {
  it("a browser-only session is not told about computer.*", () => {
    const description = buildNodeReplToolDescription(["browser"]);
    expect(description).toContain("agent.browsers");
    expect(description).toContain("Computer Use is disabled");
    expect(description).not.toContain("drives local Mac apps");
  });

  it("a computer-only session is not told about the browser", () => {
    const description = buildNodeReplToolDescription(["computer"]);
    expect(description).toContain("drives local Mac apps");
    expect(description).toContain("in-app browser is disabled");
    expect(description).toContain("Chrome control is disabled");
  });

  it("every session is told the runtime is already installed, so it writes no bootstrap", () => {
    expect(buildNodeReplToolDescription(["computer", "browser"])).toContain(
      "Do not import or set up a client yourself",
    );
  });
});

describe("the banner follows the enabled surfaces", () => {
  it("installs only the computer runtime for a computer-only session", () => {
    const banner = buildNodeReplBanner(["computer"]);
    expect(banner).toContain("setupComputerUseRuntime");
    expect(banner).not.toContain("setupBrowserRuntime");
  });

  it("installs the browser runtime for chrome too: same agent.browsers, different backend", () => {
    const banner = buildNodeReplBanner(["chrome"]);
    expect(banner).toContain("setupBrowserRuntime");
    expect(banner).not.toContain("setupComputerUseRuntime");
  });

  it("emits the browser runtime once when browser and chrome are both on", () => {
    const banner = buildNodeReplBanner(["browser", "chrome"]) ?? "";
    // Count the chunk, not an identifier inside it: one chunk mentions the
    // setup call and its env var more than once each.
    expect(banner.match(/Browser \(agent\.browsers\)/g)?.length).toBe(1);
  });

  it("is undefined with no surfaces, so no setup call is made at all", () => {
    expect(buildNodeReplBanner([])).toBeUndefined();
  });
});

describe("output clamping", () => {
  it("leaves a normal result untouched", () => {
    expect(clampNodeReplOutput("hello", 25_000)).toBe("hello");
  });

  it("keeps both ends of an oversized result", () => {
    // The head carries the structure being read; the tail carries the last
    // write and the completion value, which is usually the answer.
    const text = "HEAD" + "x".repeat(5_000) + "TAIL";
    const clamped = clampNodeReplOutput(text, 100); // 400 chars
    expect(clamped.startsWith("HEAD")).toBe(true);
    expect(clamped.endsWith("TAIL")).toBe(true);
    expect(clamped).toContain("node_repl truncated");
    expect(clamped.length).toBeLessThan(text.length);
  });
});

describe("the banner runs once per kernel, before the model's first line", () => {
  it("is already in place for the first call, and is not replayed on the second", async () => {
    const session = new NodeReplSession({
      socketPath: SOCK,
      banner: `globalThis.__setupRuns = (globalThis.__setupRuns ?? 0) + 1;`,
    });
    try {
      const first = await session.run(`return globalThis.__setupRuns;`);
      expect(first.result).toBe(1);
      const second = await session.run(`return globalThis.__setupRuns;`);
      expect(second.result).toBe(1);
    } finally {
      await session.dispose();
    }
  });

  it("surfaces what the banner wrote in the first result only", async () => {
    const session = new NodeReplSession({
      socketPath: SOCK,
      banner: `nodeRepl.write("setup diagnostic\\n");`,
    });
    try {
      const first = await session.run(`nodeRepl.write("model output");`);
      expect(first.output).toBe("setup diagnostic\nmodel output");
      const second = await session.run(`nodeRepl.write("model output");`);
      expect(second.output).toBe("model output");
    } finally {
      await session.dispose();
    }
  });

  it("replays after reset, because reset drops the kernel the globals lived in", async () => {
    const session = new NodeReplSession({
      socketPath: SOCK,
      banner: `globalThis.__setupRuns = (globalThis.__setupRuns ?? 0) + 1;`,
    });
    try {
      await session.run(`globalThis.__modelState = "dirty";`);
      await session.reset();
      const after = await session.run(
        `return [globalThis.__setupRuns, globalThis.__modelState ?? "gone"].join(",");`,
      );
      // The banner ran again against a fresh kernel; the model's own state did not survive.
      expect(after.result).toBe("1,gone");
    } finally {
      await session.dispose();
    }
  });

  it("reports a failing banner without refusing to run the model's code", async () => {
    // A broken host path must not turn into a dead session: the call may not
    // need the surface that failed to install.
    const session = new NodeReplSession({
      socketPath: SOCK,
      banner: `throw new Error("client path missing");`,
    });
    try {
      const { result, output } = await session.run(`return 1 + 1;`);
      expect(result).toBe(2);
      expect(output).toContain("runtime setup failed");
      expect(output).toContain("client path missing");
    } finally {
      await session.dispose();
    }
  });
});
