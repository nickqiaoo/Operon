import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAccessDenied } from "./chrome-fs-access.ts";
import { DEFAULT_EXTENSION_IDS } from "./chrome-native-host-install.ts";

/**
 * Is our extension installed, and in which Chrome profile?
 *
 * Chrome keeps a per-profile registry of installed extensions on disk, so this can be
 * answered without talking to Chrome or waiting for a connection to fail. That matters for
 * settings UI: "not installed" and "installed but the host is broken" need different advice,
 * and a failed connection alone cannot tell them apart.
 *
 * ## Read Secure Preferences, not Preferences
 *
 * The official troubleshooting doc says to scan each profile's `Preferences`. That is stale.
 * Chrome moved extension settings into `Secure Preferences` (protected prefs, MAC-verified
 * against tampering), and on a current Chrome `Preferences.extensions.settings` is empty
 * while `Secure Preferences` holds every extension. A detector following the doc reports
 * "not installed" always. We read both and merge, since the split has moved before and
 * Chromium forks are not all in the same place.
 *
 * ## Enabled is `disable_reasons`, not `state`
 *
 * The legacy `state` field (1 = enabled, 0 = disabled) is simply absent on a current Chrome.
 * What is present is `disable_reasons`: absent or empty means enabled, non-empty means
 * disabled, each entry being a reason code (1 = disabled by the user). Reading `state` gets
 * `undefined` for everything and cannot distinguish enabled from disabled at all.
 */

/** Chrome-family user data directories on macOS, keyed the same as the host installer. */
const USER_DATA_DIRS_MACOS: Record<string, string> = {
  chrome: "Google/Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "BraveSoftware/Brave-Browser",
};

/** Chrome's Manifest::Location for an unpacked extension — a dev build, not a Store install. */
const LOCATION_UNPACKED = 4;

export interface ProfileDetection {
  /** Profile directory name, e.g. "Default" or "Profile 1". */
  directory: string;
  installed: boolean;
  enabled: boolean;
  /** Loaded unpacked rather than installed from the Web Store. */
  unpacked: boolean;
  /** True for the profile Chrome would open, per Local State. */
  selected: boolean;
}

export interface ChromeDetection {
  /** A Chrome-family user data directory exists at all. */
  browserInstalled: boolean;
  profiles: ProfileDetection[];
  /** Installed *and* enabled in at least one profile — the extension can actually connect. */
  installed: boolean;
  /** Present somewhere but disabled everywhere: a different problem, with different advice. */
  disabled: boolean;
  /**
   * Which of the scanned extension ids is installed (enabled preferred). Null if none.
   * Settings UI shows this so a Store install is not mistaken for the dev id.
   */
  matchedExtensionId: string | null;
  /**
   * macOS refused the read, so nothing below `browserInstalled` was observed.
   *
   * Distinct from "not installed" and load-bearing: every other field is false
   * here because we could not look, not because we looked and found nothing.
   * The UI has to say "grant access", not "install the extension".
   */
  permissionDenied: boolean;
}

export interface DetectOptions {
  /** Single id to look for. Ignored when `extensionIds` is set. */
  extensionId?: string;
  /** Ids to look for (dev + Store by default). First enabled match wins per profile. */
  extensionIds?: readonly string[];
  homeDir?: string;
  /** Which Chrome-family browser to scan. Defaults to Chrome itself. */
  browser?: string;
  /** Overrides the user data directory outright. For tests. */
  userDataDir?: string;
}

interface ExtensionEntry {
  disable_reasons?: unknown;
  location?: unknown;
  manifest?: unknown;
  path?: unknown;
}

export function chromeUserDataDir(options: DetectOptions = {}): string {
  if (options.userDataDir != null) return options.userDataDir;
  const homeDir = options.homeDir ?? os.homedir();
  const browserDir = USER_DATA_DIRS_MACOS[options.browser ?? "chrome"];
  if (browserDir === undefined) throw new Error(`Unknown browser "${options.browser}"`);
  return path.join(homeDir, "Library", "Application Support", browserDir);
}

function resolveExtensionIds(options: DetectOptions): readonly string[] {
  if (options.extensionIds != null && options.extensionIds.length > 0) {
    return options.extensionIds;
  }
  if (options.extensionId != null && options.extensionId !== "") {
    return [options.extensionId];
  }
  return DEFAULT_EXTENSION_IDS;
}

export function detectChromeExtension(options: DetectOptions = {}): ChromeDetection {
  const extensionIds = resolveExtensionIds(options);
  const userDataDir = chromeUserDataDir(options);
  if (!fs.existsSync(userDataDir)) {
    return {
      browserInstalled: false,
      profiles: [],
      installed: false,
      disabled: false,
      matchedExtensionId: null,
      permissionDenied: false,
    };
  }

  // `existsSync` is a stat and passes even when TCC will refuse the listing, so the
  // denial lands here rather than on the early return above.
  let profileDirs: string[];
  try {
    profileDirs = listProfileDirs(userDataDir);
  } catch (e) {
    if (!isAccessDenied(e)) throw e;
    return {
      browserInstalled: true,
      profiles: [],
      installed: false,
      disabled: false,
      matchedExtensionId: null,
      permissionDenied: true,
    };
  }

  const selectedProfile = readSelectedProfile(userDataDir);
  const profiles: ProfileDetection[] = [];
  let matchedEnabled: string | null = null;
  let matchedInstalled: string | null = null;

  for (const directory of profileDirs) {
    let best: { entry: ExtensionEntry; id: string } | null = null;
    for (const id of extensionIds) {
      const entry = readExtensionEntry(path.join(userDataDir, directory), id);
      if (entry == null || !isInstalled(entry)) continue;
      // Prefer an enabled install if both dev and Store are present in one profile.
      if (best == null || (isEnabled(entry) && !isEnabled(best.entry))) {
        best = { entry, id };
      }
    }
    if (best != null) {
      const enabled = isEnabled(best.entry);
      if (matchedInstalled == null) matchedInstalled = best.id;
      if (enabled && matchedEnabled == null) matchedEnabled = best.id;
      profiles.push({
        directory,
        installed: true,
        enabled,
        unpacked: best.entry.location === LOCATION_UNPACKED,
        selected: directory === selectedProfile,
      });
    } else {
      profiles.push({
        directory,
        installed: false,
        enabled: false,
        unpacked: false,
        selected: directory === selectedProfile,
      });
    }
  }

  return {
    browserInstalled: true,
    profiles,
    installed: profiles.some((p) => p.installed && p.enabled),
    disabled: profiles.some((p) => p.installed) && !profiles.some((p) => p.enabled),
    matchedExtensionId: matchedEnabled ?? matchedInstalled,
    permissionDenied: false,
  };
}

/**
 * Is this entry a real install, or the stub Chrome leaves behind after an uninstall?
 *
 * `manifest` alone is not the answer, even though it looks like it. Chrome only inlines the
 * manifest for a *packed* extension; for an unpacked one it stores `path` and re-reads the
 * manifest off disk every load — so keying on `manifest` rejects every unpacked extension,
 * which is exactly how a developer build gets loaded. Either field means a real install;
 * an uninstall leftover carries neither (verified against a real profile: leftovers have no
 * manifest, no path, and no location).
 */
function isInstalled(entry: ExtensionEntry): boolean {
  return entry.manifest != null || (typeof entry.path === "string" && entry.path !== "");
}

/**
 * Enabled unless Chrome recorded a reason not to be.
 *
 * Absent and empty both mean enabled: Chrome omits the key entirely for some extensions and
 * writes `[]` for others, and the two mean the same thing.
 */
function isEnabled(entry: ExtensionEntry): boolean {
  const reasons = entry.disable_reasons;
  if (reasons == null) return true;
  return Array.isArray(reasons) ? reasons.length === 0 : false;
}

function listProfileDirs(userDataDir: string): string[] {
  return fs
    .readdirSync(userDataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === "Default" || e.name.startsWith("Profile ")))
    // A directory without a Preferences file is not a usable profile.
    .filter((e) => hasAnyPrefs(path.join(userDataDir, e.name)))
    .map((e) => e.name)
    .sort();
}

function hasAnyPrefs(profileDir: string): boolean {
  return prefsFiles(profileDir).some((file) => fs.existsSync(file));
}

/** Both files, newest layout first. Chrome has moved extensions between them before. */
function prefsFiles(profileDir: string): string[] {
  return [path.join(profileDir, "Secure Preferences"), path.join(profileDir, "Preferences")];
}

function readExtensionEntry(profileDir: string, extensionId: string): ExtensionEntry | null {
  for (const file of prefsFiles(profileDir)) {
    const prefs = readJson(file);
    if (prefs == null) continue;
    const settings = (prefs as { extensions?: { settings?: Record<string, unknown> } }).extensions
      ?.settings;
    const entry = settings?.[extensionId];
    if (entry != null && typeof entry === "object") return entry as ExtensionEntry;
  }
  return null;
}

function readSelectedProfile(userDataDir: string): string | null {
  const state = readJson(path.join(userDataDir, "Local State"));
  const profile = (state as { profile?: { last_used?: unknown } } | null)?.profile;
  if (typeof profile?.last_used === "string" && profile.last_used !== "") return profile.last_used;
  // A Chrome that has only ever used one profile records no last_used; it means Default.
  return "Default";
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    // Missing, or being rewritten by a running Chrome. Either way we have nothing to say.
    return null;
  }
}
