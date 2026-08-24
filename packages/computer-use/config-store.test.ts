import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTomlConfigStore, noopConfigStore } from "./configStore.ts";
import { NodeReplSession } from "./NodeReplSession.ts";
import { createNodeReplFacade } from "./kernel/facade.ts";

/**
 * `nodeRepl.config`: the store behind browser security policy and approval
 * memory.
 *
 * Why it has to exist:
 *
 *   function Re(){ let t = globalThis.nodeRepl; return t?.config == null ? void 0 : t }
 *   function ts(){ let t = Re()?.createElicitation;
 *     if (t == null) throw new Error("Browser security unavailable outside node repl"); … }
 *
 * With `config` absent the whole nodeRepl is treated as missing and `tab.goto()`
 * throws. This is easy to misdiagnose: `title()` and `url()` keep working, since
 * they do not cross origins, and only `goto()` fails.
 */

const SOCK = "/tmp/opcu-config-unused.sock";

async function run(code: string) {
  const s = new NodeReplSession({ socketPath: SOCK });
  try {
    return await s.run(code, { session_id: "s", turn_id: "t" });
  } finally {
    await s.dispose();
  }
}

const tmp = () => fs.promises.mkdtemp(path.join(os.tmpdir(), "opcu-cfg-"));

describe("the gate: config has to be on the kernel realm's façade", () => {
  const facade = () => createNodeReplFacade(async () => ({}), { env: {}, requestMeta: {} });

  it("with config absent, the whole nodeRepl is treated as missing", () => {
    // The check is: a nodeRepl whose config is null resolves to undefined.
    const Re = (g: { nodeRepl?: { config?: unknown } }) =>
      g.nodeRepl?.config == null ? undefined : g.nodeRepl;

    const { nodeRepl } = facade();
    expect(Re({ nodeRepl })).toBeDefined(); // With config, the node repl is recognised.
    expect(Re({ nodeRepl: { ...nodeRepl, config: undefined } })).toBeUndefined(); // Without it, everything falls over.
  });

  it("the kernel realm's nodeRepl carries all four config methods, which is what trusted modules see", () => {
    const { nodeRepl } = facade();
    expect(Object.keys(nodeRepl.config).sort()).toEqual([
      "read",
      "readRequirements",
      "readToml",
      "writeToml",
    ]);
  });

  it("the untrusted façade has no config: otherwise model code could write its own allowlist and walk past the consent gate", () => {
    const { untrustedNodeRepl } = facade();
    expect(untrustedNodeRepl.config).toBeUndefined();
  });

  it("model code in the vm sandbox really cannot reach config", async () => {
    const { result } = await run(`return typeof nodeRepl.config;`);
    expect(result).toBe("undefined");
  });
});

describe("createTomlConfigStore", () => {
  it("readToml returns {} for a missing file and must not throw, since a throw fails closed as deny", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await expect(store.readToml("browser/config.toml")).resolves.toEqual({});
  });

  it("writeToml then readToml round-trips, creating directories as needed", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await store.writeToml("browser/config.toml", { origins: { "https://example.com": "allow" } });
    await expect(store.readToml("browser/config.toml")).resolves.toEqual({
      origins: { "https://example.com": "allow" },
    });
  });

  it("what lands on disk is real TOML, editable by hand and read by the Settings page", async () => {
    const root = await tmp();
    const store = createTomlConfigStore({ root });
    await store.writeToml("browser/config.toml", { approval_mode: "never_ask" });
    const text = await fs.promises.readFile(path.join(root, "browser/config.toml"), "utf8");
    expect(text).toContain("approval_mode");
    expect(text).toContain("never_ask");
  });

  it("the per-conversation path, `browser/sessions/<id>.toml`", async () => {
    const root = await tmp();
    const store = createTomlConfigStore({ root });
    await store.writeToml("browser/sessions/abc.toml", { origins: { "https://a.com": "allow" } });
    expect(fs.existsSync(path.join(root, "browser/sessions/abc.toml"))).toBe(true);
  });

  it("read() reads config.toml at the root, the same file operon already uses, so domains can be pre-authorised", async () => {
    const root = await tmp();
    await fs.promises.writeFile(
      path.join(root, "config.toml"),
      'default_permissions = "trusted"\n\n[permissions.trusted.network]\nallowed_domains = ["example.com"]\n',
    );
    const store = createTomlConfigStore({ root });
    expect(await store.read({})).toMatchObject({
      default_permissions: "trusted",
      permissions: { trusted: { network: { allowed_domains: ["example.com"] } } },
    });
  });

  it("readRequirements() returns {}: operon has no administrator policy channel", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await expect(store.readRequirements()).resolves.toEqual({});
  });

  it("a syntactically broken config file is treated as empty rather than throwing, which would stop the browser navigating at all", async () => {
    const root = await tmp();
    await fs.promises.writeFile(path.join(root, "config.toml"), "this is [not valid toml =====");
    const store = createTomlConfigStore({ root });
    await expect(store.read({})).resolves.toEqual({});
  });
});

describe("path containment: defence in depth, since this writes to the user's disk", () => {
  it("refuses a relative path that escapes the root", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await expect(store.writeToml("../../.ssh/authorized_keys", { x: 1 })).rejects.toThrow(
      /outside config root/,
    );
    await expect(store.readToml("../../../etc/passwd")).rejects.toThrow(/outside config root/);
  });

  it("refuses an absolute path", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await expect(store.writeToml("/etc/passwd", { x: 1 })).rejects.toThrow(/absolute path/);
  });

  it("permits a nested path inside the root", async () => {
    const store = createTomlConfigStore({ root: await tmp() });
    await expect(store.writeToml("browser/sessions/x.toml", { a: 1 })).resolves.toBeUndefined();
  });
});

describe("noopConfigStore: the fallback when a host configures no store", () => {
  it("entirely empty and never throwing, since a throw reads as deny", async () => {
    await expect(noopConfigStore.readRequirements()).resolves.toEqual({});
    await expect(noopConfigStore.read({})).resolves.toEqual({});
    await expect(noopConfigStore.readToml("browser/config.toml")).resolves.toEqual({});
    await expect(noopConfigStore.writeToml("browser/config.toml", { a: 1 })).resolves.toBeUndefined();
  });
});
