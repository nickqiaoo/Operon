// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { NodeReplHost } from "./NodeReplHost.ts";

const RUN_FIXTURE_E2E =
  process.platform === "darwin"
  && process.env.OPERON_RUN_COMPUTER_USE_FIXTURE_E2E === "1";
const describeFixtureE2E = RUN_FIXTURE_E2E ? describe : describe.skip;
const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWIFT_PACKAGE = path.join(REPO_ROOT, "native/computer-use");
const SERVICE_BIN = path.join(SWIFT_PACKAGE, ".build/debug/operon-computer-use");
const FIXTURE_BIN = path.join(SWIFT_PACKAGE, ".build/debug/operon-cua-appkit-fixture");
const FIXTURE_BUNDLE_ID = "dev.operon.cua-e2e.appkit";
const FIXTURE_DISPLAY_NAME = "Operon CUA AppKit Fixture";

interface PointState {
  x: number;
  y: number;
}

interface RectState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FixtureState {
  pid: number;
  ready: boolean;
  incrementCount: number;
  coordinateCount: number;
  inputValue: string;
  keyValue: string;
  lastKey: string;
  lastKeyCode?: number;
  searchValue: string;
  searchSubmitCount: number;
  scrollOffsetY: number;
  dragCount: number;
  dragStart?: PointState;
  dragEnd?: PointState;
  toggleValue: boolean;
  selectedLocation: number;
  selectedLength: number;
  selectedText: string;
  focusedIdentifier?: string;
  keyWindow: boolean;
  windowWidth: number;
  windowHeight: number;
  elementFrames: Record<string, RectState>;
}

interface AppState {
  app: string;
  screenshot: { url: string } | null;
  text: string;
}

interface ElementReference {
  index: number;
  line: string;
  frame: { x: number; y: number; width: number; height: number };
}

function currentFrontmostBundleIdentifier(): string {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
  }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8" },
  );
  const match = /"CFBundleIdentifier"="([^"]+)"/.exec(info);
  if (!match) throw new Error(`Could not resolve frontmost app from: ${info}`);
  return match[1];
}

function buildSwiftProducts(): void {
  for (const product of ["operon-computer-use", "operon-cua-appkit-fixture"]) {
    execFileSync("/usr/bin/swift", ["build", "--product", product], {
      cwd: SWIFT_PACKAGE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function createFixtureApp(tempDirectory: string): string {
  const appPath = path.join(tempDirectory, `${FIXTURE_DISPLAY_NAME}.app`);
  const contents = path.join(appPath, "Contents");
  const macOS = path.join(contents, "MacOS");
  fs.mkdirSync(macOS, { recursive: true });
  const executablePath = path.join(macOS, "operon-cua-appkit-fixture");
  fs.copyFileSync(FIXTURE_BIN, executablePath);
  fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${FIXTURE_DISPLAY_NAME}</string>
  <key>CFBundleExecutable</key><string>operon-cua-appkit-fixture</string>
  <key>CFBundleIdentifier</key><string>${FIXTURE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${FIXTURE_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
    "utf8",
  );
  return appPath;
}

/// A run that dies before `afterAll` (a killed pipe, a crashed worker) leaves the
/// fixture app running. The next run then binds to that stale instance, whose
/// window is gone, and every case fails with `cgWindowNotFound`.
function killStaleFixtures(): void {
  try {
    execFileSync("/usr/bin/pkill", ["-f", "operon-cua-appkit-fixture"], { stdio: "ignore" });
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

function readFixtureState(statePath: string): FixtureState | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as FixtureState;
  return state.ready ? state : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function elementByIdentifier(
  text: string,
  identifier: string,
  logicalFrame: RectState | undefined,
  screenshotScale: number,
): ElementReference {
  const identifierPattern = new RegExp(`(?:^|\\s)ID: ${escapeRegExp(identifier)}(?=\\s|,|$)`);
  const line = text.split("\n").find((candidate) => identifierPattern.test(candidate));
  if (!line) throw new Error(`Could not find ${identifier} in accessibility tree:\n${text}`);

  const indexMatch = /^\s*(\d+)\s/.exec(line);
  const frameMatch = /Frame: x=(-?\d+), y=(-?\d+), w=(\d+), h=(\d+)/.exec(line);
  if (!indexMatch || (!frameMatch && !logicalFrame)) {
    throw new Error(`Could not parse element reference from: ${line}`);
  }
  const frame = frameMatch
    ? {
        x: Number(frameMatch[1]),
        y: Number(frameMatch[2]),
        width: Number(frameMatch[3]),
        height: Number(frameMatch[4]),
      }
    : {
        x: Math.round(logicalFrame!.x * screenshotScale),
        y: Math.round(logicalFrame!.y * screenshotScale),
        width: Math.round(logicalFrame!.width * screenshotScale),
        height: Math.round(logicalFrame!.height * screenshotScale),
      };
  return {
    index: Number(indexMatch[1]),
    line,
    frame,
  };
}

function screenshotScaleFor(state: AppState, fixture: FixtureState): number {
  const url = state.screenshot?.url;
  if (!url?.startsWith("file:")) return 1;
  const filePath = fileURLToPath(url);
  const output = execFileSync(
    "/usr/bin/sips",
    ["-g", "pixelWidth", filePath],
    { encoding: "utf8" },
  );
  const match = /pixelWidth:\s*(\d+)/.exec(output);
  if (!match || fixture.windowWidth <= 0) return 1;
  return Number(match[1]) / fixture.windowWidth;
}

function center(element: ElementReference): { x: number; y: number } {
  return {
    x: element.frame.x + Math.max(2, Math.floor(element.frame.width / 2)),
    y: element.frame.y + Math.max(2, Math.floor(element.frame.height / 2)),
  };
}

describeFixtureE2E("Computer Use controlled AppKit E2E", () => {
  let tempDirectory = "";
  let appPath = "";
  let statePath = "";
  let socketPath = "";
  let service: ChildProcess | undefined;
  let serviceStderr = "";
  let host: NodeReplHost | undefined;
  let fixturePID: number | undefined;
  const foregroundViolations = new Set<string>();
  let foregroundSample: NodeJS.Timeout | undefined;

  async function executeSky<T>(source: string): Promise<T> {
    if (!host) throw new Error("NodeReplHost is not ready");
    const result = await host.exec(source) as T;
    const frontmostAfter = currentFrontmostBundleIdentifier();
    if (frontmostAfter === FIXTURE_BUNDLE_ID) foregroundViolations.add(frontmostAfter);
    return result;
  }

  async function getState(): Promise<AppState> {
    return await executeSky<AppState>(
      `return await computer.get_app_state({ app: ${JSON.stringify(appPath)}, disableDiff: true });`,
    );
  }

  async function waitForState(
    predicate: (state: FixtureState) => boolean,
    description: string,
  ): Promise<FixtureState> {
    return await waitFor(() => {
      const state = readFixtureState(statePath);
      return state && predicate(state) ? state : undefined;
    }, description, 8_000);
  }

  beforeAll(async () => {
    buildSwiftProducts();
    killStaleFixtures();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "operon-cua-appkit-e2e-"));
    appPath = createFixtureApp(tempDirectory);
    statePath = path.join(tempDirectory, "fixture-state.json");
    socketPath = path.join(tempDirectory, "computer-use.sock");

    const frontmostBeforeLaunch = currentFrontmostBundleIdentifier();
    if (frontmostBeforeLaunch === FIXTURE_BUNDLE_ID) {
      throw new Error("The AppKit fixture must not be frontmost before the E2E test");
    }

    execFileSync(
      "/usr/bin/open",
      ["-g", appPath, "--args", "--state-file", statePath],
      { stdio: "ignore" },
    );
    const fixtureState = await waitFor(
      () => readFixtureState(statePath),
      "AppKit fixture readiness",
    );
    fixturePID = fixtureState.pid;
    const frontmostAfterLaunch = currentFrontmostBundleIdentifier();
    expect(frontmostAfterLaunch).not.toBe(FIXTURE_BUNDLE_ID);

    // Fresh per-run path: Screen Recording is TCC-keyed by binary path, and a
    // stale deny on the build output turns every capture into a full-timeout
    // stall with no screenshot — which looks exactly like a product bug.
    const servicePath = path.join(tempDirectory, "operon-computer-use");
    fs.copyFileSync(SERVICE_BIN, servicePath);
    fs.chmodSync(servicePath, 0o755);
    service = spawn(servicePath, [socketPath], {
      stdio: ["ignore", "ignore", "pipe"],
      // Screenshot capture stays off here: this suite's coordinate helpers scale
      // element frames by the screenshot's pixel size, and screenshots are
      // size-bounded (1280px wide here, i.e. 1.68x — not the display's 2x), so
      // turning capture on shifts the whole suite's coordinate space. Screenshot
      // coverage lives in the Electron suite instead.
      env: {
        ...process.env,
        OPERON_CU_DISABLE_SCREENSHOT_CAPTURE: "1",
      },
    });
    service.stderr?.on("data", (chunk) => {
      serviceStderr += String(chunk);
    });
    await waitFor(
      () => fs.existsSync(socketPath) ? true : undefined,
      "Computer Use socket",
    );

    host = new NodeReplHost({
      cwd: REPO_ROOT,
      env: { SKY_CUA_NATIVE_PIPE_PATH: socketPath },
      tmpDir: tempDirectory,
    });

    foregroundSample = setInterval(() => {
      void execFileAsync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" })
        .then(({ stdout: asn }) => execFileAsync(
          "/usr/bin/lsappinfo",
          ["info", "-only", "bundleID", asn.trim()],
          { encoding: "utf8" },
        ))
        .then(({ stdout: info }) => {
          const match = /"CFBundleIdentifier"="([^"]+)"/.exec(info);
          if (match?.[1] === FIXTURE_BUNDLE_ID) foregroundViolations.add(match[1]);
        })
        .catch(() => {
          // A synchronous before/after check still guards every action.
        });
    }, 25);
  }, 60_000);

  afterAll(async () => {
    if (foregroundSample) clearInterval(foregroundSample);
    // Asserted here as well as inside the coverage case: every later case runs
    // actions too, and a foreground steal in one of them used to go unchecked.
    expect(foregroundViolations, serviceStderr).toEqual(new Set());
    await host?.dispose();
    service?.kill("SIGTERM");
    if (fixturePID) {
      spawnSync("/bin/kill", ["-TERM", String(fixturePID)], { stdio: "ignore" });
    }
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("covers every currently working public computer action without changing foreground focus", async () => {
    const apps = await executeSky<Array<{ id: string; displayName?: string }>>(
      "return await computer.list_apps();",
    );
    expect(apps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: FIXTURE_BUNDLE_ID, displayName: FIXTURE_DISPLAY_NAME }),
    ]));

    const initial = await getState();
    expect(initial.app).toBe(appPath);
    expect(initial.text).toContain("Computer Use E2E Fixture");
    if (initial.screenshot != null) {
      expect(initial.screenshot.url).toMatch(/^file:/);
    }

    const fixture = await waitForState(() => true, "fixture state");
    const screenshotScale = screenshotScaleFor(initial, fixture);

    const element = (identifier: string) => elementByIdentifier(
      initial.text,
      identifier,
      fixture.elementFrames[identifier],
      screenshotScale,
    );
    const windowElement = elementByIdentifier(
      initial.text,
      "fixture.window",
      { x: 0, y: 0, width: fixture.windowWidth, height: fixture.windowHeight },
      screenshotScale,
    );
    const coordinate = element("fixture.coordinate");
    const input = element("fixture.input");
    const search = element("fixture.search");
    const drag = element("fixture.drag");

    const coordinatePoint = center(coordinate);
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, x: ${coordinatePoint.x}, y: ${coordinatePoint.y} });`,
    );
    await waitForState((state) => state.coordinateCount === 1, "coordinate click");

    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(appPath)}, element_index: ${input.index}, value: "set by AX" });`,
    );
    await waitForState((state) => state.inputValue === "set by AX", "set_value");

    const searchPoint = center(search);
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, x: ${searchPoint.x}, y: ${searchPoint.y} });`,
    );
    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(appPath)}, element_index: ${search.index}, value: "query" });`,
    );
    await waitForState(
      (state) => state.searchValue === "query",
      "search set_value",
    );

    const dragStart = {
      x: drag.frame.x + 30,
      y: drag.frame.y + Math.floor(drag.frame.height / 2),
    };
    const dragEnd = {
      x: drag.frame.x + drag.frame.width - 30,
      y: dragStart.y,
    };
    await executeSky(
      `return await computer.drag({ app: ${JSON.stringify(appPath)}, from_x: ${dragStart.x}, from_y: ${dragStart.y}, to_x: ${dragEnd.x}, to_y: ${dragEnd.y} });`,
    );
    await waitForState((state) => state.dragCount === 1, "drag");

    await executeSky(
      `return await computer.perform_secondary_action({ app: ${JSON.stringify(appPath)}, element_index: ${windowElement.index}, action: "Raise" });`,
    );

    expect(
      foregroundViolations,
      `Foreground changed during AppKit fixture E2E. Service stderr:\n${serviceStderr}`,
    ).toEqual(new Set());
    expect(currentFrontmostBundleIdentifier()).not.toBe(FIXTURE_BUNDLE_ID);
  }, 180_000);

  it("selects an unambiguous text range through the public API", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const selectable = elementByIdentifier(
      state.text,
      "fixture.selectable",
      fixture.elementFrames["fixture.selectable"],
      screenshotScaleFor(state, fixture),
    );
    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(appPath)}, element_index: ${selectable.index}, value: "alpha target omega | alpha second omega" });`,
    );
    await executeSky(
      `return await computer.select_text({ app: ${JSON.stringify(appPath)}, element_index: ${selectable.index}, text: "target", prefix: "alpha ", suffix: " omega" });`,
    );
    await waitForState(
      (next) => next.selectedText === "target" && next.selectedLength === 6,
      "select_text",
    );
  }, 60_000);

  it("scrolls a background AppKit scroll view", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const scroll = elementByIdentifier(
      state.text,
      "fixture.scroll",
      fixture.elementFrames["fixture.scroll"],
      screenshotScaleFor(state, fixture),
    );
    const offset = fixture.scrollOffsetY;
    await executeSky(
      `return await computer.scroll({ app: ${JSON.stringify(appPath)}, element_index: ${scroll.index}, direction: "down" });`,
    );
    await waitForState(
      (next) => next.scrollOffsetY > offset,
      "background scroll",
    );
  }, 60_000);

  it("types into a background text field after a coordinate click", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const input = elementByIdentifier(
      state.text,
      "fixture.input",
      fixture.elementFrames["fixture.input"],
      screenshotScaleFor(state, fixture),
    );
    const point = center(input);
    // type_text appends at the caret like real typing, so seed a known value
    // first — an earlier case leaves "set by AX" in this field.
    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(appPath)}, element_index: ${input.index}, value: "seed:" });`,
    );
    await waitForState((next) => next.inputValue === "seed:", "seeded input");
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, x: ${point.x}, y: ${point.y} });`,
    );
    await executeSky(
      `return await computer.type_text({ app: ${JSON.stringify(appPath)}, text: "typed text" });`,
    );
    await waitForState(
      (next) => next.inputValue === "seed:typed text",
      "background type_text",
    );
  }, 60_000);

  it("clicks a native button by element index in the background", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const increment = elementByIdentifier(
      state.text,
      "fixture.increment",
      fixture.elementFrames["fixture.increment"],
      screenshotScaleFor(state, fixture),
    );
    const count = fixture.incrementCount;
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, element_index: ${increment.index} });`,
    );
    await waitForState(
      (next) => next.incrementCount === count + 1,
      "background element click",
    );
  }, 60_000);

  // Delivery is observed through the field's value, not through
  // `KeyCaptureTextField.keyDown`: AppKit routes text input to the window's
  // field editor, so an NSTextField subclass's `keyDown` legitimately never
  // fires for typed characters. Asserting on that override is what made a
  // working key path look like a delivery gap.
  it("delivers press_key to a background AppKit text field", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const keyCapture = elementByIdentifier(
      state.text,
      "fixture.key-capture",
      fixture.elementFrames["fixture.key-capture"],
      screenshotScaleFor(state, fixture),
    );
    const point = center(keyCapture);
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, x: ${point.x}, y: ${point.y} });`,
    );
    await executeSky(
      `return await computer.press_key({ app: ${JSON.stringify(appPath)}, key: "a" });`,
    );
    await waitForState(
      (next) => next.keyValue === "a",
      "background press_key delivery",
    );
  }, 60_000);

  it("autosubmits a focused search field after set_value", async () => {
    const state = await getState();
    const fixture = await waitForState(() => true, "fixture state");
    const search = elementByIdentifier(
      state.text,
      "fixture.search",
      fixture.elementFrames["fixture.search"],
      screenshotScaleFor(state, fixture),
    );
    const point = center(search);
    const submitCount = fixture.searchSubmitCount;
    await executeSky(
      `return await computer.click({ app: ${JSON.stringify(appPath)}, x: ${point.x}, y: ${point.y} });`,
    );
    await executeSky(
      `return await computer.set_value({ app: ${JSON.stringify(appPath)}, element_index: ${search.index}, value: "autosubmit" });`,
    );
    // Not `=== submitCount + 1`: focusing a field makes AppKit end the previous
    // field's editing session, and NSSearchField fires its action on that too,
    // so a background set_value can legitimately submit more than once.
    await waitForState(
      (next) => next.searchSubmitCount > submitCount && next.searchValue === "autosubmit",
      "search autosubmit Return delivery",
    );
  }, 60_000);
});
