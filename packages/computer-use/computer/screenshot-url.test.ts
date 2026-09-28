// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computer, mapAppState, materializeScreenshotUrl } from "./index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("materializeScreenshotUrl", () => {
  it("turns data URLs into short file:// references", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-shot-"));
    tempDirs.push(dir);
    // 1x1 PNG
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const url = materializeScreenshotUrl(`data:image/png;base64,${png}`, dir);
    expect(url).toMatch(/^file:\/\//);
    const filePath = fileURLToPath(url!);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it("removes screenshot files older than an hour when it writes a new one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-prune-"));
    tempDirs.push(dir);
    const shots = path.join(dir, "operon-computer-use-shots");
    fs.mkdirSync(shots, { recursive: true });
    const old = path.join(shots, "shot-old.png");
    const recent = path.join(shots, "shot-recent.png");
    const unrelated = path.join(shots, "keep-me.txt");
    for (const f of [old, recent, unrelated]) fs.writeFileSync(f, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(unrelated, twoHoursAgo, twoHoursAgo);

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const url = materializeScreenshotUrl(`data:image/png;base64,${png}`, dir);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(fileURLToPath(url!))).toBe(true);
  });

  it("passes file:// through unchanged", () => {
    expect(materializeScreenshotUrl("file:///tmp/a.png")).toBe("file:///tmp/a.png");
  });

  it("returns null for empty input", () => {
    expect(materializeScreenshotUrl(null)).toBeNull();
    expect(materializeScreenshotUrl("")).toBeNull();
  });
});

describe("computer", () => {
  it("exposes the mac target discriminator", () => {
    expect(computer.target).toBe("mac");
  });
});

describe("mapAppState", () => {
  it("maps text for the model and materializes screenshots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-map-"));
    tempDirs.push(dir);
    (globalThis as { nodeRepl?: { tmpDir?: string } }).nodeRepl = { tmpDir: dir };

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const state = mapAppState(
      "TextEdit",
      {
        app: { bundleIdentifier: "com.apple.TextEdit", pid: 1 },
        skyshot: {
          text: "[1] window",
          screenshot: { url: `data:image/png;base64,${png}`, mimeType: "image/png" },
        },
      },
      new Set(),
    );

    expect(state.text).toBe("[1] window");
    expect(state.app).toBe("TextEdit");
    expect(state.screenshot?.url).toMatch(/^file:\/\//);
    // Must not keep multi-KB data URLs on the model-facing object.
    expect(state.screenshot?.url.startsWith("data:")).toBe(false);
  });
});
