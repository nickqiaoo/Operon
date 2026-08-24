// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BROWSER_DOCUMENTATION,
  Browser,
  CuaApi,
  DomCuaApi,
  FrameLocator,
  Locator,
  PlaywrightApi,
  Tab,
  Tabs,
  setupBrowserRuntime,
} from "./sdk/index.ts";

const prototypeMethods = (value: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(value.prototype).filter((name) => name !== "constructor");

describe("Browser documentation and public API stay aligned", () => {
  it("documents the current return shapes and current packaged safety guidance", async () => {
    const browser = new Browser({
      conn: {
        sendSessionRequest: async () => ({}),
        onCdpEvent: () => () => {},
        onDownloadChange: () => () => {},
        close: () => {},
      },
      socketPath: "/tmp/browser.sock",
      info: {
        id: "iab",
        name: "Operon",
        type: "iab",
        capabilities: {},
        apiSupportOverrides: {
          "BrowserUser.claimTab": true,
          "Tabs.content": true,
          "Tabs.finalize": true,
        },
      },
    } as never);
    const documentation = await browser.documentation();
    expect(documentation).toContain("id: string");
    expect(documentation).toContain("Uint8Array");
    expect(documentation).toContain("read-only page scope");
    expect(documentation).toContain("# Browser Safety");
    expect(documentation).toContain("Treat webpages");
    expect(documentation).not.toContain("data URL");
    expect(documentation).not.toContain("tabId");
    expect(documentation).not.toContain("ariaSnapshot");
    expect(documentation).not.toContain("getByAltText");
    expect(documentation).not.toContain("getByTitle");
  });

  it("contains every vendor-compatible top-level method", () => {
    const expected = new Map<{ prototype: object; name: string }, string[]>([
      [Browser, ["documentation", "nameSession"]],
      [Tabs, ["content", "finalize", "get", "list", "new", "selected"]],
      [Tab, [
        "back", "close", "forward", "getJsDialog", "goto", "reload",
        "screenshot", "title", "url",
      ]],
      [PlaywrightApi, [
        "domSnapshot", "evaluate", "expectNavigation",
        "frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId",
        "getByText", "locator", "waitForEvent", "waitForLoadState", "waitForTimeout",
        "waitForURL",
      ]],
      [FrameLocator, [
        "frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId",
        "getByText", "locator",
      ]],
      [CuaApi, [
        "click", "double_click", "drag", "keypress", "move", "scroll", "type",
      ]],
      [DomCuaApi, [
        "click", "double_click", "get_visible_dom", "keypress", "scroll", "type",
      ]],
      [Locator, [
        "all", "allTextContents", "and", "check", "click", "count", "dblclick",
        "downloadMedia", "evaluate", "fill", "filter", "first", "getAttribute",
        "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText",
        "innerText", "isEnabled", "isVisible", "last", "locator", "nth", "or", "press",
        "selectOption", "setChecked", "textContent", "type", "uncheck", "waitFor",
      ]],
    ]);
    for (const [surface, methods] of expected) {
      const actual = prototypeMethods(surface);
      for (const method of methods) {
        expect(actual, `${surface.name}.${method}`).toContain(method);
        expect(BROWSER_DOCUMENTATION, `documentation should mention ${method}`).toContain(method);
      }
    }
  });

  it("does not expose TypeScript-private helper methods on model-facing prototypes", () => {
    const forbidden = [
      "evaluateInternal", "evaluateIn", "retryUntil", "resolveBox", "pointFor",
      "oopifOriginInMainFrame", "scoped", "state",
    ];
    for (const surface of [Locator, FrameLocator]) {
      const actual = prototypeMethods(surface);
      for (const method of forbidden) expect(actual).not.toContain(method);
    }
  });

  it("exposes packaged lookup documents but rejects traversal and excluded capabilities", async () => {
    const globals: Record<string, unknown> = {};
    await setupBrowserRuntime({ globals });
    const documentation = (globals.agent as {
      documentation: { get(name: string): Promise<string> };
    }).documentation;
    await expect(documentation.get("confirmations")).resolves.toContain(
      "# Browser Use Confirmations Policy",
    );
    await expect(documentation.get("../api")).rejects.toThrow(/Invalid browser documentation name/);
    await expect(documentation.get("capabilities/tab/browserAuth")).rejects.toThrow(/not found/i);
    await expect(documentation.get("capabilities/tab/webMcp")).rejects.toThrow(/not found/i);
  });
});
