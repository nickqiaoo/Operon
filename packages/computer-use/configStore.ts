import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * The host-side contract for `nodeRepl.config`: the store behind browser
 * security policy and approval memory.
 *
 * It is not optional. Callers decide whether they are running inside a node repl
 * by checking whether `config` exists at all, and its absence makes the whole
 * nodeRepl look missing, so the cross-origin consent gate cannot find
 * createElicitation and throws. See the `config` comment in kernel/facade.ts.
 *
 * These calls must fail closed. The policy lookup around them is wrapped in
 * `try { … } catch { return "deny" }`, so throwing denies the navigation. An
 * implementation with no data has to return an empty object instead.
 */
export interface NodeReplConfigStore {
  /** Administrator (MDM) policy, shaped `{requirements?:{network?:{…}}}`.
   *  Return `{}` when there is none. */
  readRequirements(): Promise<unknown>;
  /** User config. Callers read `default_permissions` from it and resolve
   *  `permissions[profile].network`. */
  read(opts: { cwd?: string | null; includeLayers?: boolean }): Promise<unknown>;
  /** Read TOML at a relative path such as `browser/config.toml`. Return `{}` when
   *  it does not exist. */
  readToml(relPath: string): Promise<unknown>;
  /** Write TOML at a relative path, creating directories as needed. */
  writeToml(relPath: string, value: unknown): Promise<void>;
}

export interface TomlConfigStoreOptions {
  /**
   * Config root, `~/.operon` by default.
   *
   * The paths handed in are relative (`browser/config.toml`,
   * `browser/sessions/<conversationId>.toml`), and the host chooses what they
   * resolve against. This is why operon's approvals never land in another
   * agent's configuration directory.
   */
  root?: string;
  /** Filename `read()` looks for, `config.toml` by default: the same file operon
   *  already uses for its own configuration. */
  configFile?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v);

/**
 * The default implementation: TOML files on disk.
 *
 * Same relative paths and same TOML format as the contract expects, rooted at
 * operon's own directory, with user config reusing `~/.operon/config.toml`. That
 * means a user can pre-authorise domains by hand with `default_permissions` and
 * `permissions.<profile>.network.allowed_domains`.
 */
export function createTomlConfigStore(opts: TomlConfigStoreOptions = {}): NodeReplConfigStore {
  const root = path.resolve(opts.root ?? path.join(os.homedir(), ".operon"));
  const configFile = opts.configFile ?? "config.toml";

  /**
   * Pin a relative path inside the root.
   *
   * The only callers are trusted imported modules, since `config` never reaches
   * the untrusted façade and model code cannot touch it. But this writes to the
   * user's disk, which earns defence in depth: something like
   * `../../.ssh/authorized_keys` should not be allowed through on the grounds
   * that the caller is trusted.
   */
  const resolveInRoot = (relPath: string): string => {
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error("nodeRepl.config: path must be a non-empty string");
    }
    if (path.isAbsolute(relPath)) {
      throw new Error(`nodeRepl.config: refusing absolute path ${relPath}`);
    }
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`nodeRepl.config: refusing path outside config root: ${relPath}`);
    }
    return abs;
  };

  const readTomlFile = async (abs: string): Promise<Record<string, unknown>> => {
    let text: string;
    try {
      text = await fs.promises.readFile(abs, "utf8");
    } catch {
      return {}; // Absent means empty config. Never throw: the caller fails
                 // closed and would read a throw as deny.
    }
    try {
      const parsed = parseToml(text);
      return isRecord(parsed) ? parsed : {};
    } catch {
      // A syntactically broken config file should not make the browser unusable.
      // Treat it as empty: no pre-authorisation, so the user gets asked.
      return {};
    }
  };

  return {
    // Operon has no mechanism for pushing administrator policy. Returning `{}`
    // yields the default policy (nothing enabled, no allow or deny lists, no hard
    // deny), which refuses nothing and falls through to asking the user. That is
    // exactly the default we want.
    async readRequirements() {
      return {};
    },
    async read() {
      return await readTomlFile(path.join(root, configFile));
    },
    async readToml(relPath: string) {
      return await readTomlFile(resolveInRoot(relPath));
    },
    async writeToml(relPath: string, value: unknown) {
      const abs = resolveInRoot(relPath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, stringifyToml(isRecord(value) ? value : {}), "utf8");
    },
  };
}

/**
 * Fallback for a host that configured no store: empty, read-only, and never
 * throwing.
 *
 * The behaviour is no pre-authorisation and no memory of choices, so the user is
 * asked every time. Safe but tiresome; a real product integration should pass
 * `createTomlConfigStore()`. What matters most is that it does not throw, since
 * a throw reads as deny and the browser could not navigate at all.
 */
export const noopConfigStore: NodeReplConfigStore = {
  readRequirements: async () => ({}),
  read: async () => ({}),
  readToml: async () => ({}),
  writeToml: async () => {},
};
