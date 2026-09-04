// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeReplHost } from "./NodeReplHost.ts";

const RUN_FIXTURE_E2E =
  process.platform === "darwin"
  && process.env.OPERON_RUN_COMPUTER_USE_FIXTURE_E2E === "1";
const describeFixtureE2E = RUN_FIXTURE_E2E ? describe : describe.skip;
const FIXTURE_CTX = "fixture";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWIFT_PACKAGE = path.join(REPO_ROOT, "native/computer-use");
const SERVICE_BIN = path.join(SWIFT_PACKAGE, ".build/debug/operon-computer-use");
const ELECTRON_TEMPLATE_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_TEMPLATE_BIN = path.join(ELECTRON_TEMPLATE_APP, "Contents/MacOS/Electron");
const FIXTURE_DIRECTORY = path.join(REPO_ROOT, "packages/computer-use/fixtures/electron");
const ELECTRON_BUNDLE_ID = "dev.operon.cua-e2e.electron";
const ELECTRON_DISPLAY_NAME = "Operon CUA Electron Fixture";

interface RectState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElectronFixtureState {
  pid: number;
  ready: boolean;
  incrementCount: number;
  coordinateCount: number;
  inputValue: string;
  keyValue: string;
  keyDownCount: number;
  lastKey: string;
  searchValue: string;
  searchSubmitCount: number;
  focusedId: string;
  windowWidth: number;
  windowHeight: number;
  elementFrames: Record<string, RectState>;
}

interface AppState {
  app: string;
  screenshot?: { url: string } | null;
  text: string;
}

interface ElementReference {
  index: number;
  frame: RectState;
}

function currentFrontmostBundleIdentifier(): string {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8" },
  );
  const match = /"CFBundleIdentifier"="([^"]+)"/.exec(info);
  if (!match) throw new Error(`Could not resolve frontmost app from: ${info}`);
  return match[1];
}

/// See the AppKit fixture: a stale instance from an aborted run keeps the bundle
/// id alive, and the next run resolves to its dead window (`cgWindowNotFound`).
function killStaleFixtures(): void {
  try {
    execFileSync("/usr/bin/pkill", ["-f", ELECTRON_DISPLAY_NAME], { stdio: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matched — that is the normal case.
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

function readFixtureState(statePath: string): ElectronFixtureState | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as ElectronFixtureState;
  return state.ready ? state : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function elementByAccessibilityName(
  text: string,
  accessibilityName: string,
  frame: RectState | undefined,
): ElementReference {
  const namePattern = new RegExp(
    `(?:Description: )?${escapeRegExp(accessibilityName)}(?=\\s|,|$)`,
    "i",
  );
  const line = text.split("\n").find((candidate) => namePattern.test(candidate));
  const indexMatch = line == null ? undefined : /^\s*(\d+)\s/.exec(line);
  if (!line || !indexMatch || !frame) {
    throw new Error(`Could not resolve ${accessibilityName} from Electron accessibility tree:\n${text}`);
  }
  return { index: Number(indexMatch[1]), frame };
}

function createElectronFixtureApp(tempDirectory: string): string {
  const appPath = path.join(tempDirectory, `${ELECTRON_DISPLAY_NAME}.app`);
  execFileSync("/bin/cp", ["-cR", ELECTRON_TEMPLATE_APP, appPath], { stdio: "ignore" });
  const plist = path.join(appPath, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleIdentifier", ELECTRON_BUNDLE_ID],
    ["CFBundleName", ELECTRON_DISPLAY_NAME],
    ["CFBundleDisplayName", ELECTRON_DISPLAY_NAME],
  ]) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], {
      stdio: "ignore",
    });
  }
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "ignore",
  });
  return appPath;
}

describeFixtureE2E("Computer Use controlled Electron E2E", () => {
  let tempDirectory = "";
  let statePath = "";
  let socketPath = "";
  let electronAppPath = "";
  let electronBin = "";
  let electron: ChildProcess | undefined;
  let service: ChildProcess | undefined;
  let host: NodeReplHost | undefined;
  let serviceStderr = "";
  let electronStderr = "";
  const foregroundViolations = new Set<string>();

  async function executeSky<T>(source: string): Promise<T> {
    if (!host) throw new Error("NodeReplHost is not ready");
    const result = await host.exec(FIXTURE_CTX, source) as T;
    const frontmost = currentFrontmostBundleIdentifier();
    if (frontmost === ELECTRON_BUNDLE_ID) foregroundViolations.add(frontmost);
    return result;
  }

  async function getState(): Promise<AppState> {
    return await executeSky<AppState>(
      `return await computer.get_app_state({ app: ${JSON.stringify(electronAppPath)}, disableDiff: true });`,
    );
  }

  async function waitForState(
    predicate: (state: ElectronFixtureState) => boolean,
    description: string,
  ): Promise<ElectronFixtureState> {
    return await waitFor(() => {
      const state = readFixtureState(statePath);
      return state && predicate(state) ? state : undefined;
    }, description, 8_000);
  }

  beforeAll(async () => {
    if (!fs.existsSync(ELECTRON_TEMPLATE_BIN)) {
      throw new Error(`Electron runtime not found: ${ELECTRON_TEMPLATE_BIN}`);
    }
    execFileSync("/usr/bin/swift", ["build", "--product", "operon-computer-use"], {
      cwd: SWIFT_PACKAGE,
      stdio: ["ignore", "pipe", "pipe"],
    });

    killStaleFixtures();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "operon-cua-electron-e2e-"));
    electronAppPath = createElectronFixtureApp(tempDirectory);
    electronBin = path.join(electronAppPath, "Contents/MacOS/Electron");
    statePath = path.join(tempDirectory, "fixture-state.json");
    socketPath = path.join(tempDirectory, "computer-use.sock");
    electron = spawn(
      electronBin,
      [
        FIXTURE_DIRECTORY,
        `--state-file=${statePath}`,
        `--user-data-dir=${path.join(tempDirectory, "user-data")}`,
        "--no-first-run",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    electron.stderr?.on("data", (chunk) => {
      electronStderr += String(chunk);
    });
    try {
      await waitFor(() => readFixtureState(statePath), "Electron fixture readiness", 20_000);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${electronStderr}`);
    }
    expect(currentFrontmostBundleIdentifier()).not.toBe(ELECTRON_BUNDLE_ID);

    // Run the service from a fresh path inside the temp dir. Screen Recording is
    // TCC-keyed by binary path, and a stale deny on the build output makes every
    // capture stall for the full timeout and return no screenshot — which is
    // indistinguishable from a product bug. A per-run path can't inherit one.
    const servicePath = path.join(tempDirectory, "operon-computer-use");
    fs.copyFileSync(SERVICE_BIN, servicePath);
    fs.chmodSync(servicePath, 0o755);
    service = spawn(servicePath, [socketPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    service.stderr?.on("data", (chunk) => {
      serviceStderr += String(chunk);
    });
    await waitFor(
      () => fs.existsSync(socketPath) ? true : undefined,
      "Computer Use socket",
    );
    // One kernel now serves many vm contexts, so even a single-context test has
    // to name the one it runs in.
    host = new NodeReplHost({
      cwd: REPO_ROOT,
      env: { SKY_CUA_NATIVE_PIPE_PATH: socketPath },
      tmpDir: tempDirectory,
    });
    await host.createContext(FIXTURE_CTX);
  }, 60_000);

  afterAll(async () => {
    // Whole-suite invariant: the controlled app must never become frontmost in
    // any case, not only the first one.
    expect(foregroundViolations, serviceStderr).toEqual(new Set());
    await host?.dispose();
    service?.kill("SIGTERM");
    electron?.kill("SIGTERM");
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("routes initial type_text through the focused Electron AX value", async () => {
    const initial = await getState();
    expect(initial.text).toMatch(/HTML content|AXWebArea|Computer Use Electron E2E Fixture/i);
    const fixture = await waitForState(() => true, "fixture state");
    const input = elementByAccessibilityName(
      initial.text,
      "Fixture Input",
      fixture.elementFrames["fixture-input"],
    );

    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(electronAppPath)}, element_index: ${input.index} });`,
    );
    const focused = await waitForState(
      (next) => next.focusedId === "fixture-input",
      "Electron input focus",
    );
    await getState();
    await executeSky(
      `return await computer.type_text({ app: ${JSON.stringify(electronAppPath)}, text: "typed through AX" });`,
    );
    const afterType = await waitForState(
      (next) => next.inputValue === "typed through AX",
      "Electron type_text AX assignment",
    );
    expect(afterType.keyDownCount).toBe(focused.keyDownCount);
    expect(foregroundViolations, serviceStderr).toEqual(new Set());
  }, 60_000);

  // Regression: a hydrated web tree used to return `screenshot: null` forever.
  // The first capture was skipped because a settle pass was supposed to take it,
  // and the settle pass early-returned for "already hydrated" trees, so nothing
  // ever captured. Nothing asserted on `screenshot`, so it went unnoticed until
  // a real QQ session hit it.
  it("returns a window screenshot for a web-backed window", async () => {
    const state = await getState();
    expect(state.screenshot, "get_app_state returned no screenshot").not.toBeNull();
    const url = state.screenshot!.url;
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith(".jpg")).toBe(true);
    const bytes = fs.readFileSync(fileURLToPath(url));
    expect(bytes.byteLength).toBeGreaterThan(1024);
    // JPEG magic — proves it is a real image, not an empty placeholder, and that
    // we still encode the way Codex does (its bytes start with FF D8 FF too).
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 60_000);

  it("proves set_value updates Electron without a keyboard event", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const input = elementByAccessibilityName(
      state.text,
      "Fixture Input",
      fixture.elementFrames["fixture-input"],
    );
    const keyDownCount = fixture.keyDownCount;
    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(electronAppPath)}, element_index: ${input.index}, value: "set directly" });`,
    );
    const afterSet = await waitForState(
      (next) => next.inputValue === "set directly",
      "Electron set_value",
    );
    expect(afterSet.keyDownCount).toBe(keyDownCount);
  }, 60_000);

  // type_text appends at the caret, exactly like typing; it does not replace
  // the field. The previous test leaves "set directly" in the input, so the
  // expected result is the concatenation. This used to be an `it.fails` case
  // asserting bare equality, which made an append look like a delivery gap.
  it("appends type_text after a previous AX value assignment", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const input = elementByAccessibilityName(
      state.text,
      "Fixture Input",
      fixture.elementFrames["fixture-input"],
    );
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(electronAppPath)}, element_index: ${input.index} });`,
    );
    await waitForState((next) => next.focusedId === "fixture-input", "Electron input focus");
    await getState();
    await executeSky(
      `return await computer.type_text({ app: ${JSON.stringify(electronAppPath)}, text: "typed after set" });`,
    );
    await waitForState(
      (next) => next.inputValue === "set directlytyped after set",
      "Electron type_text after set_value",
    );
  }, 60_000);

  it("delivers press_key to a background Chromium window", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const input = elementByAccessibilityName(
      state.text,
      "Fixture Input",
      fixture.elementFrames["fixture-input"],
    );
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(electronAppPath)}, element_index: ${input.index} });`,
    );
    await waitForState(
      (next) => next.focusedId === "fixture-input",
      "Electron focused input",
    );
    const keyDownCount = readFixtureState(statePath)?.keyDownCount ?? 0;
    await executeSky(
      `return await computer.press_key({ app: ${JSON.stringify(electronAppPath)}, key: "a" });`,
    );
    await waitForState(
      (next) => next.keyDownCount === keyDownCount + 1 && next.lastKey.toLowerCase() === "a",
      "Electron background press_key",
    );
  }, 60_000);
});
