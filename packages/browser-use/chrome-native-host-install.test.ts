import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_IDS,
  DEV_EXTENSION_ID,
  NATIVE_HOST_NAME,
  STORE_EXTENSION_ID,
  chromeNativeHostStatus,
  installChromeNativeHost,
  uninstallChromeNativeHost,
  wrapperPath,
} from "./chrome-native-host-install.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fake $HOME with the given browsers' support dirs already present. */
async function tempHome(browsers: string[] = ["Google/Chrome"]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-native-host-install-"));
  tempDirs.push(dir);
  for (const browser of browsers) {
    await fs.promises.mkdir(path.join(dir, "Library", "Application Support", browser), {
      recursive: true,
    });
  }
  return dir;
}

const readManifest = async (file: string) =>
  JSON.parse(await fs.promises.readFile(file, "utf8")) as {
    name: string;
    path: string;
    type: string;
    allowed_origins: string[];
  };

// The installer writes into Chrome's own configuration directories and refuses
// to run anywhere but macOS, so these cannot execute on a Linux CI runner.
const isDarwin = process.platform === "darwin";

describe.skipIf(!isDarwin)("installChromeNativeHost", () => {
  it("writes an executable wrapper that execs the operon binary", async () => {
    const homeDir = await tempHome();
    const result = await installChromeNativeHost({
      homeDir,
      execPath: "/Applications/operon.app/Contents/MacOS/operon",
      execArgs: [],
    });

    const script = await fs.promises.readFile(result.wrapperPath, "utf8");
    expect(script).toContain('exec "/Applications/operon.app/Contents/MacOS/operon" --chrome-native-host');
    // Chrome runs this file directly; without the x bit it fails as a generic connect error.
    expect(fs.statSync(result.wrapperPath).mode & 0o111).toBeTruthy();
  });

  it("passes the app path through when running unpackaged", async () => {
    // A dev build's execPath is the bare Electron binary; without the app path it loads none
    // of our code and prints Electron's usage text to stdout — which on this pipe reads as
    // garbage frames rather than as an error.
    const homeDir = await tempHome();
    const result = await installChromeNativeHost({
      homeDir,
      execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      execArgs: ["/repo"],
    });

    const script = await fs.promises.readFile(result.wrapperPath, "utf8");
    expect(script).toContain(
      'exec "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "/repo" --chrome-native-host',
    );
  });

  it("points the manifest at the wrapper and allows our extension ids", async () => {
    // The whole reason we cannot use someone else's published extension: this list binds the
    // host to specific ids, so it has to be ours (dev unpacked + Web Store).
    const homeDir = await tempHome();
    const result = await installChromeNativeHost({ homeDir, execPath: "/bin/echo", execArgs: [] });
    const manifest = await readManifest(result.manifestPaths[0]);

    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.type).toBe("stdio");
    expect(manifest.path).toBe(result.wrapperPath);
    expect(manifest.allowed_origins).toEqual(
      DEFAULT_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    );
    expect(manifest.allowed_origins).toContain(`chrome-extension://${STORE_EXTENSION_ID}/`);
  });

  it("allows an explicit extensionIds override", async () => {
    const homeDir = await tempHome();
    const result = await installChromeNativeHost({
      homeDir,
      execPath: "/bin/echo",
      execArgs: [],
      extensionIds: [DEV_EXTENSION_ID, "aaaabbbbccccddddeeeeffffgggghhhh"],
    });
    const manifest = await readManifest(result.manifestPaths[0]);
    expect(manifest.allowed_origins).toHaveLength(2);
  });

  it("installs for every Chrome-family browser that is present", async () => {
    const homeDir = await tempHome(["Google/Chrome", "BraveSoftware/Brave-Browser"]);
    const result = await installChromeNativeHost({ homeDir, execPath: "/bin/echo", execArgs: [] });
    expect(result.manifestPaths).toHaveLength(2);
  });

  it("skips browsers that are not installed", async () => {
    // Creating the tree for an absent browser leaves litter that outlives us and is never read.
    const homeDir = await tempHome(["Google/Chrome"]);
    const result = await installChromeNativeHost({ homeDir, execPath: "/bin/echo", execArgs: [] });

    expect(result.manifestPaths).toHaveLength(1);
    expect(
      fs.existsSync(path.join(homeDir, "Library", "Application Support", "Microsoft Edge")),
    ).toBe(false);
  });

  it("rewrites the wrapper when the binary moves", async () => {
    // An upgrade changes the versioned path. A stale wrapper execs something that is gone,
    // which Chrome only reports as a generic connection failure.
    const homeDir = await tempHome();
    await installChromeNativeHost({ homeDir, execPath: "/versions/1", execArgs: [] });
    await installChromeNativeHost({ homeDir, execPath: "/versions/2", execArgs: [] });

    const script = await fs.promises.readFile(wrapperPath(homeDir), "utf8");
    expect(script).toContain('exec "/versions/2"');
    expect(script).not.toContain("/versions/1");
    expect(fs.statSync(wrapperPath(homeDir)).mode & 0o111).toBeTruthy();
  });

  it("keeps the wrapper silent, since stdout is the protocol pipe", async () => {
    const homeDir = await tempHome();
    const result = await installChromeNativeHost({ homeDir, execPath: "/bin/echo", execArgs: [] });
    const script = await fs.promises.readFile(result.wrapperPath, "utf8");

    for (const line of script.split("\n")) {
      const code = line.trim();
      if (code === "" || code.startsWith("#")) continue;
      expect(code).toMatch(/^exec /);
    }
  });
});

describe.skipIf(!isDarwin)("chromeNativeHostStatus", () => {
  it("reports nothing installed on a clean home", async () => {
    const homeDir = await tempHome();
    expect(await chromeNativeHostStatus({ homeDir })).toEqual({
      installed: false,
      manifestPaths: [],
      execPathExists: false,
    });
  });

  it("confirms a live install whose binary still exists", async () => {
    const homeDir = await tempHome();
    await installChromeNativeHost({ homeDir, execPath: process.execPath, execArgs: [] });
    const status = await chromeNativeHostStatus({ homeDir });

    expect(status.installed).toBe(true);
    expect(status.execPathExists).toBe(true);
  });

  it("reads past a second quoted argument to find the binary", async () => {
    // A dev wrapper execs `"<electron>" "<app path>" --chrome-native-host`. Matching the
    // exec target greedily swallows both into one path that cannot exist, so a healthy
    // install reports itself broken and the UI tells the user to repair a working feature.
    const homeDir = await tempHome();
    await installChromeNativeHost({ homeDir, execPath: process.execPath, execArgs: ["/some/app/path"] });
    const status = await chromeNativeHostStatus({ homeDir });

    expect(status.installed).toBe(true);
    expect(status.execPathExists).toBe(true);
  });

  it("spots an install whose binary has gone", async () => {
    const homeDir = await tempHome();
    await installChromeNativeHost({ homeDir, execPath: "/versions/deleted-by-an-upgrade", execArgs: [] });
    const status = await chromeNativeHostStatus({ homeDir });

    expect(status.installed).toBe(true);
    expect(status.execPathExists).toBe(false);
  });
});

// Same as the two suites above: uninstall calls install to set up its fixture, and install
// throws outright on a non-darwin platform.
describe.skipIf(!isDarwin)("uninstallChromeNativeHost", () => {
  it("removes the manifest and the wrapper", async () => {
    const homeDir = await tempHome(["Google/Chrome", "Chromium"]);
    const installed = await installChromeNativeHost({ homeDir, execPath: "/bin/echo", execArgs: [] });

    const removed = await uninstallChromeNativeHost({ homeDir });

    expect(removed).toEqual([...installed.manifestPaths, installed.wrapperPath]);
    expect(fs.existsSync(installed.wrapperPath)).toBe(false);
    expect(await chromeNativeHostStatus({ homeDir })).toMatchObject({ installed: false });
  });

  it("is a no-op when nothing was installed", async () => {
    const homeDir = await tempHome();
    await expect(uninstallChromeNativeHost({ homeDir })).resolves.toEqual([]);
  });
});
