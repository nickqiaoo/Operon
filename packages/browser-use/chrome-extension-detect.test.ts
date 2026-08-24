import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChromeExtension } from "./chrome-extension-detect.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const EXT = "igdpiihejmmlnpbhnjoellojnbnnbhia";

interface ProfileSpec {
  /** Which prefs file the extension registry goes in. Current Chrome uses Secure Preferences. */
  file?: "Secure Preferences" | "Preferences";
  entry?: Record<string, unknown> | null;
  /** Written to the *other* prefs file, to prove we read both. */
  otherFileEmpty?: boolean;
}

async function fakeChrome(
  profiles: Record<string, ProfileSpec>,
  lastUsed?: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-chrome-detect-"));
  tempDirs.push(dir);
  for (const [name, spec] of Object.entries(profiles)) {
    const profileDir = path.join(dir, name);
    fs.mkdirSync(profileDir, { recursive: true });
    const file = spec.file ?? "Secure Preferences";
    const settings = spec.entry == null ? {} : { [EXT]: spec.entry };
    fs.writeFileSync(
      path.join(profileDir, file),
      JSON.stringify({ extensions: { settings } }),
    );
    if (spec.otherFileEmpty) {
      const other = file === "Secure Preferences" ? "Preferences" : "Secure Preferences";
      fs.writeFileSync(path.join(profileDir, other), JSON.stringify({ extensions: { settings: {} } }));
    }
  }
  if (lastUsed != null) {
    fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ profile: { last_used: lastUsed } }));
  }
  return dir;
}

const installedEntry = (over: Record<string, unknown> = {}) => ({
  manifest: { name: "Operon Browser Use" },
  location: 1,
  disable_reasons: [],
  ...over,
});

describe("detectChromeExtension", () => {
  it("reports no browser when Chrome was never installed", async () => {
    const detection = detectChromeExtension({ userDataDir: "/nonexistent/chrome" });
    expect(detection).toEqual({
      browserInstalled: false,
      profiles: [],
      installed: false,
      disabled: false,
      matchedExtensionId: null,
    });
  });

  it("finds an extension registered in Secure Preferences", async () => {
    // The one that matters: current Chrome puts every extension here, and the official
    // troubleshooting doc's "read Preferences" would find nothing at all.
    const userDataDir = await fakeChrome({ Default: { entry: installedEntry(), otherFileEmpty: true } });
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.installed).toBe(true);
    expect(detection.matchedExtensionId).toBe(EXT);
    expect(detection.profiles).toEqual([
      { directory: "Default", installed: true, enabled: true, unpacked: false, selected: true },
    ]);
  });

  it("still finds one registered in the older Preferences layout", async () => {
    const userDataDir = await fakeChrome({ Default: { file: "Preferences", entry: installedEntry() } });
    expect(detectChromeExtension({ userDataDir, extensionId: EXT }).installed).toBe(true);
  });

  it("reports absent when the profile has other extensions but not ours", async () => {
    const userDataDir = await fakeChrome({ Default: { entry: null } });
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.browserInstalled).toBe(true);
    expect(detection.installed).toBe(false);
    expect(detection.profiles[0].installed).toBe(false);
  });

  it("treats a non-empty disable_reasons as disabled", async () => {
    // 1 = disabled by the user. This is the field the current Chrome actually writes.
    const userDataDir = await fakeChrome({
      Default: { entry: installedEntry({ disable_reasons: [1] }) },
    });
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.installed).toBe(false);
    expect(detection.disabled).toBe(true);
    expect(detection.profiles[0]).toMatchObject({ installed: true, enabled: false });
  });

  it("treats an absent disable_reasons as enabled", async () => {
    // Chrome omits the key for some extensions and writes [] for others; both mean enabled.
    // The legacy `state` field is gone, so keying off it would call everything disabled.
    const entry = installedEntry();
    delete (entry as { disable_reasons?: unknown }).disable_reasons;
    const userDataDir = await fakeChrome({ Default: { entry } });

    expect(detectChromeExtension({ userDataDir, extensionId: EXT }).installed).toBe(true);
  });

  it("ignores an uninstall leftover, which has neither manifest nor path", async () => {
    // Chrome keeps a stub entry after an uninstall. Counting it reports a removed extension
    // as present, and the user gets told to fix a connection that can never work.
    const userDataDir = await fakeChrome({ Default: { entry: { location: 1, disable_reasons: [] } } });
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.installed).toBe(false);
    expect(detection.profiles[0].installed).toBe(false);
  });

  it("counts an unpacked dev build, which has a path and no manifest", async () => {
    // Chrome only inlines `manifest` for packed extensions; an unpacked one gets `path` and
    // the manifest is re-read off disk each load. Requiring `manifest` therefore rejects
    // every developer build — the exact shape a real "Load unpacked" produces.
    const userDataDir = await fakeChrome({
      Default: {
        entry: { location: 4, disable_reasons: [], path: "/repo/packages/chrome-extension" },
      },
    });
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.profiles[0]).toMatchObject({ installed: true, enabled: true, unpacked: true });
    expect(detection.installed).toBe(true);
  });

  it("flags a packed install as not unpacked", async () => {
    const userDataDir = await fakeChrome({ Default: { entry: installedEntry({ location: 1 }) } });
    expect(detectChromeExtension({ userDataDir, extensionId: EXT }).profiles[0].unpacked).toBe(false);
  });

  it("scans every profile and marks the one Chrome would open", async () => {
    const userDataDir = await fakeChrome(
      {
        Default: { entry: null },
        "Profile 1": { entry: installedEntry() },
        "Profile 2": { entry: null },
      },
      "Profile 1",
    );
    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });

    expect(detection.profiles.map((p) => p.directory)).toEqual(["Default", "Profile 1", "Profile 2"]);
    expect(detection.profiles.find((p) => p.selected)?.directory).toBe("Profile 1");
    expect(detection.installed).toBe(true);
  });

  it("defaults to Default when Local State records no last_used", async () => {
    // A Chrome that has only ever used one profile writes no last_used.
    const userDataDir = await fakeChrome({ Default: { entry: installedEntry() } });
    expect(detectChromeExtension({ userDataDir, extensionId: EXT }).profiles[0].selected).toBe(true);
  });

  it("skips directories that are not profiles", async () => {
    const userDataDir = await fakeChrome({ Default: { entry: installedEntry() } });
    fs.mkdirSync(path.join(userDataDir, "ShaderCache"), { recursive: true });
    fs.mkdirSync(path.join(userDataDir, "Safe Browsing"), { recursive: true });

    expect(detectChromeExtension({ userDataDir, extensionId: EXT }).profiles).toHaveLength(1);
  });

  it("survives a prefs file being rewritten under it", async () => {
    // Chrome rewrites these while running, so a read can land on a truncated file. That is a
    // transient nothing, not a reason to throw at a settings page.
    const userDataDir = await fakeChrome({ Default: { entry: installedEntry() } });
    fs.writeFileSync(path.join(userDataDir, "Default", "Secure Preferences"), "{ truncated");

    const detection = detectChromeExtension({ userDataDir, extensionId: EXT });
    expect(detection.browserInstalled).toBe(true);
    expect(detection.installed).toBe(false);
  });
});
