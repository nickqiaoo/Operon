import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromeAccessDeniedError, isAccessDenied } from "./chrome-fs-access.ts";

/**
 * Installs the native messaging host so Chrome will spawn us for our extension.
 *
 * Two files, and they must agree with each other and with the extension:
 *
 *   1. a wrapper script that execs the operon binary with --chrome-native-host;
 *   2. a manifest naming that script and listing the extension ids allowed to connect.
 *
 * A native messaging host does not have to be a compiled binary — the manifest's `path`
 * only has to be executable. Claude Code's installed host on this machine is itself a
 * three-line shell script exec'ing its main binary, which is the same shape as ours. Using
 * our already-signed binary avoids codesigning and notarizing a second executable.
 */

/** Must match NATIVE_HOST_NAME in the extension's background.js. */
export const NATIVE_HOST_NAME = "com.operon.browser_use.extension";

/**
 * Our extension's id under "Load unpacked", pinned by the `key` field in its manifest.
 *
 * Chrome would otherwise derive the id from the install path, so it would differ per machine
 * and no fixed `allowed_origins` could match. The Web Store assigns its own id at listing
 * time; both live in `DEFAULT_EXTENSION_IDS` so a dev build and a Store install both work.
 */
export const DEV_EXTENSION_ID = "igdpiihejmmlnpbhnjoellojnbnnbhia";

/**
 * Chrome Web Store listing id (Operon Browser Use). Assigned when the item is created in
 * the developer dashboard — not the same as the unpacked id above.
 */
export const STORE_EXTENSION_ID = "annipikgonognboogflchfnagmhbbipc";

/** Ids the native host accepts by default (dev unpacked + Web Store). */
export const DEFAULT_EXTENSION_IDS: readonly string[] = [DEV_EXTENSION_ID, STORE_EXTENSION_ID];

/** Chrome-family browsers that read native messaging manifests from their own directory. */
const MANIFEST_DIRS_MACOS: Record<string, string> = {
  chrome: "Google/Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "BraveSoftware/Brave-Browser",
};

export interface InstallOptions {
  /** The executable the wrapper should exec. Defaults to this process's own binary. */
  execPath?: string;
  /**
   * Arguments before --chrome-native-host. Defaults to what this process needs (see
   * `defaultExecArgs`); pass `[]` to force none.
   */
  execArgs?: string[];
  /** Extension ids allowed to connect. Defaults to dev + Web Store ids. */
  extensionIds?: string[];
  /** Overrides $HOME. For tests. */
  homeDir?: string;
  /** Which browsers to install for. Defaults to every supported one that is present. */
  browsers?: string[];
}

/**
 * What the wrapper must pass before --chrome-native-host for this build to boot at all.
 *
 * Packaged, `process.execPath` is the operon binary with the app baked in, so it needs
 * nothing: `operon --chrome-native-host` is enough.
 *
 * In development it is the bare Electron binary, and the app is a separate path argument
 * (`electron . --chrome-native-host`). Omit it and Electron does not load our code at all —
 * it prints its own usage text **to stdout** and exits, which on this pipe is indistinguishable
 * from a backend spewing garbage frames. So dev needs the app path, and the wrapper is the
 * only place that knows it.
 *
 * `process.defaultApp` is Electron's own marker for "launched with an app path", and
 * `argv[1]` is that path. Both are absent outside Electron, where the default of no extra
 * args is already right.
 *
 * The path is resolved to an absolute one because argv[1] is whatever the launcher typed —
 * in this repo's dev script it is literally `.`. Chrome spawns the wrapper with its own
 * working directory, so a relative path would resolve somewhere else entirely, and the
 * failure would look like Electron booting the wrong app rather than a bad wrapper.
 */
function defaultExecArgs(): string[] {
  const isDefaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
  const appPath = process.argv[1];
  if (!isDefaultApp || typeof appPath !== "string" || appPath === "") return [];
  return [path.resolve(appPath)];
}

export interface InstallResult {
  wrapperPath: string;
  manifestPaths: string[];
}

/**
 * Where our wrapper script lives. Under the operon home rather than the app bundle: the
 * bundle is read-only once signed, and rewriting a file inside it would break the signature.
 */
export function wrapperPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".operon", "chrome", "chrome-native-host");
}

export function manifestPath(homeDir: string, browserDir: string): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    browserDir,
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );
}

export async function installChromeNativeHost(options: InstallOptions = {}): Promise<InstallResult> {
  if (process.platform !== "darwin") {
    // Windows registers hosts through the registry, not a manifest directory, and Linux uses
    // ~/.config/<browser>/NativeMessagingHosts. Neither is a path tweak away from this, so
    // failing loudly beats writing files nothing will ever read.
    throw new Error(`Chrome native host installation is not implemented for ${process.platform}`);
  }
  const homeDir = options.homeDir ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;
  const extensionIds = options.extensionIds ?? [...DEFAULT_EXTENSION_IDS];

  const wrapper = wrapperPath(homeDir);
  await fs.promises.mkdir(path.dirname(wrapper), { recursive: true });
  await fs.promises.writeFile(wrapper, wrapperScript(execPath, options.execArgs ?? defaultExecArgs()), {
    mode: 0o755,
  });
  // writeFile does not chmod an existing file, and an upgrade rewrites this one.
  await fs.promises.chmod(wrapper, 0o755);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Operon Browser Use native messaging host",
    path: wrapper,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };

  const browsers = options.browsers ?? Object.keys(MANIFEST_DIRS_MACOS);
  const manifestPaths: string[] = [];
  for (const browser of browsers) {
    const browserDir = MANIFEST_DIRS_MACOS[browser];
    if (browserDir === undefined) throw new Error(`Unknown browser "${browser}"`);
    // Only install where the browser already exists. Creating the tree for an absent browser
    // would leave litter that outlives us and never gets read.
    const supportDir = path.join(homeDir, "Library", "Application Support", browserDir);
    if (!fs.existsSync(supportDir)) continue;
    const target = manifestPath(homeDir, browserDir);
    // The manifest lives inside the browser's own protected directory, so an
    // ungranted app fails here for the same TCC reason detection does. Say which
    // grant is missing; a bare EPERM on a path the user never chose reads like a bug.
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (e) {
      if (isAccessDenied(e)) throw new ChromeAccessDeniedError(supportDir, { cause: e });
      throw e;
    }
    manifestPaths.push(target);
  }
  return { wrapperPath: wrapper, manifestPaths };
}

export async function uninstallChromeNativeHost(options: InstallOptions = {}): Promise<string[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const removed: string[] = [];
  for (const browserDir of Object.values(MANIFEST_DIRS_MACOS)) {
    const target = manifestPath(homeDir, browserDir);
    if (!fs.existsSync(target)) continue;
    // Unlike install, a denial here must not fail the call: the user is switching the
    // feature *off*, and removing the wrapper below already breaks the path — Chrome
    // finds a manifest pointing at a script that is gone. Blocking the switch on a
    // grant they may have just revoked would strand them with the feature stuck on.
    try {
      await fs.promises.rm(target, { force: true });
    } catch (e) {
      if (isAccessDenied(e)) continue;
      throw e;
    }
    removed.push(target);
  }
  const wrapper = wrapperPath(homeDir);
  if (fs.existsSync(wrapper)) {
    await fs.promises.rm(wrapper, { force: true });
    removed.push(wrapper);
  }
  return removed;
}

/**
 * Is the host installed and pointing at an executable that still exists?
 *
 * An upgrade that moves the binary leaves a manifest whose wrapper execs a path that is gone;
 * Chrome reports that as a generic connection failure, so check it here where we can say so.
 */
export async function chromeNativeHostStatus(
  options: InstallOptions = {},
): Promise<{ installed: boolean; manifestPaths: string[]; execPathExists: boolean }> {
  const homeDir = options.homeDir ?? os.homedir();
  const manifestPaths = Object.values(MANIFEST_DIRS_MACOS)
    .map((browserDir) => manifestPath(homeDir, browserDir))
    .filter((target) => fs.existsSync(target));
  const wrapper = wrapperPath(homeDir);
  let execPathExists = false;
  if (fs.existsSync(wrapper)) {
    const script = await fs.promises.readFile(wrapper, "utf8");
    // `[^"]+`, not `.+`: the wrapper may carry a second quoted argument (the app path, in a
    // dev build), and a greedy match would run to the last quote on the line and hand back
    // `…/Electron" "/path/to/app` as one path. It does not exist, so a healthy install would
    // report itself broken.
    const execTarget = /^exec "([^"]+)"/m.exec(script)?.[1];
    execPathExists = execTarget != null && fs.existsSync(execTarget);
  }
  return { installed: manifestPaths.length > 0, manifestPaths, execPathExists };
}

function wrapperScript(execPath: string, execArgs: string[]): string {
  // stdout is the protocol pipe, so the script must not print anything of its own.
  const args = ["", ...execArgs.map((a) => `"${a}"`), "--chrome-native-host"].join(" ");
  return `#!/bin/sh
# Operon Browser Use native messaging host.
# Generated by Operon — do not edit; reinstall from Settings instead.
exec "${execPath}"${args}
`;
}
