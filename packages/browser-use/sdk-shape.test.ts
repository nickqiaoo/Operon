// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Browser, Browsers, Tab, Tabs, PlaywrightApi } from "./sdk/index.ts";
import { PlaywrightDownload, PlaywrightFileChooser } from "./sdk/playwright.ts";

/**
 * The model-facing shape: nothing visible beyond what the documentation promises.
 *
 * The reference shape, read off `Object.keys` and the prototype after
 * `agent.browsers.get("iab")` and `tabs.new()`:
 *
 * ```
 * Browser own: [browserId, capabilities, tabs, user]
 *        proto: [constructor, documentation, nameSession]
 * Tab    own: [id, playwright, dom_cua, cua, content, clipboard, dev, capabilities]
 *        proto: [constructor, goto, markHandoff, markDeliverable, back, forward, reload,
 *                close, screenshot, title, url, getJsDialog, …]
 * ```
 *
 * No internal fields at all: no `conn`, no `playwrightInjected`, none of it.
 *
 * This is a real problem rather than tidiness. A model holding a Tab will run
 * `Object.getOwnPropertyNames(Object.getPrototypeOf(tab))` to see what is there.
 * An `evaluateOrThrow` that leaked out was picked up by an agent and used as API,
 * bypassing every check and breaking the moment it was renamed. `conn` would be
 * worse still: that is the raw transport.
 *
 * TypeScript's `private` is compile-time only and leaves an ordinary property at
 * runtime, which `getOwnPropertyNames` still sees. Real hiding means a `#` private
 * field, a WeakMap, or a closure.
 *
 * ## How it is done. Read this before changing any of these classes.
 *
 * - Internal state lives in the WeakMap in `sdk/internals.ts` (`tabCore(tab)`),
 *   leaving no property on the object.
 * - Internal methods needed across modules (`cdp`, `injectPlaywright`,
 *   `attachTarget` and so on) are module-level functions: on no prototype, so
 *   nothing can enumerate them, while an `import` in the same package reaches
 *   them.
 * - Anything with no cross-module need (`Browser#conn`, `Tabs#conn`,
 *   `Locator#tab`, Tab's `#enableDomains`) uses a `#` private field or method.
 *   Do not push those into the WeakMap as well.
 *
 * Before adding anything to Tab or Browser, ask whether the model should see it.
 * If not, it does not belong on the instance or the prototype.
 */

const own = (o: object) => Object.keys(o).sort();
const proto = (o: object) => Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {}).sort();
/** Everything the model can see: instance fields plus prototype methods. */
const surfaceOf = (o: object) => new Set([...own(o), ...proto(o)]);

/**
 * A real instance is required. `Object.create(X.prototype)` never runs the
 * constructor, so the instance fields do not exist and "conn is not exposed"
 * passes for the wrong reason.
 */
const fakeConn = { sendSessionRequest: async () => ({}), onCdpEvent: () => () => {}, onDownloadChange: () => () => {}, close: () => {} } as never;
const aTab = () => new Tab(fakeConn, 1);
const aBrowser = () => new Browser({
  conn: fakeConn,
  info: {
    id: "x",
    name: "x",
    type: "iab",
    capabilities: {},
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "Tabs.content": true,
      "Tabs.finalize": true,
    },
  },
  socketPath: "/tmp/x",
} as never);

/** Things the model must explicitly never see. */
const FORBIDDEN_ON_TAB = [
  "conn",              // The raw transport: it would let a model bypass the SDK.
  "playwrightInjected", "fetchUnsubscribe", "injectedTargets",
  "dialogUnsubscribe", "dialogHandler", "lastDialogSeen", "clipboardGranted",
  "evaluateOrThrow",   // Internal, and an agent really did use it as API.
  "cdp", "attachTarget", "oopifTargetIdForMarker", "injectPlaywrightInTarget",
  "injectPlaywright", "attach", "detach", "ensureFetchContinue", "enableDomains",
  "ensureDialogHandling", "grantClipboard", "historyGo", "mainFrameId",
];
const FORBIDDEN_ON_BROWSER = ["conn", "info"];

describe("model-facing shape: only what the documentation promises", () => {
  it("the instance fields of Browser and Tab match the documented API", () => {
    const tab = aTab();
    const browser = aBrowser();
    expect(own(tab)).toEqual([
      "capabilities", "clipboard", "content", "cua", "dev", "dom_cua", "id", "playwright",
    ]);
    expect(own(browser)).toEqual(["browserId", "capabilities", "tabs", "user"]);
    expect(proto(browser)).toEqual(["constructor", "documentation", "nameSession"]);
  });

  it("the method names of the nested API collections match the documented API", () => {
    const tab = aTab();
    const browser = aBrowser();
    expect(own(browser.capabilities)).toEqual(["get", "list"]);
    expect(own(browser.user)).toEqual(["claimTab", "openTabs"]);
    expect(own(tab.capabilities)).toEqual(["get", "list"]);
    expect(own(tab.clipboard)).toEqual(["read", "readText", "write", "writeText"]);
    expect(own(tab.content)).toEqual(["export", "exportGsuite"]);
    expect(own(tab.dev)).toEqual(["logs"]);
  });

  it("Tab's prototype is exactly the public core surface in api.json", () => {
    expect(proto(aTab())).toEqual([
      "back", "close", "constructor", "forward", "getJsDialog", "goto",
      "markDeliverable", "markHandoff", "reload", "screenshot", "title", "url",
    ]);
  });

  it("members api.json marks unsupported are hidden per backend", () => {
    const browser = aBrowser();
    expect(browser.user.history).toBeUndefined();
    expect("history" in browser.user).toBe(false);
    expect(typeof browser.tabs.content).toBe("function");
  });

  it("Playwright and Locator converge recursively on exactly api.json's members", async () => {
    const conn = {
      ...(fakeConn as Record<string, unknown>),
      sendSessionRequest: async (method: string) =>
        method === "createTab" ? { id: 1 } : {},
    } as never;
    const browser = new Browser({
      conn,
      info: {
        id: "x",
        name: "x",
        type: "iab",
        capabilities: {},
      },
      socketPath: "/tmp/x",
    } as never);
    const tab = await browser.tabs.new();
    expect(proto(tab.playwright)).toEqual([
      "constructor", "domSnapshot", "elementInfo", "elementScreenshot", "evaluate",
      "expectNavigation", "frameLocator", "getByLabel", "getByPlaceholder", "getByRole",
      "getByTestId", "getByText", "locator", "waitForEvent", "waitForLoadState",
      "waitForTimeout", "waitForURL",
    ]);
    expect("ariaSnapshot" in tab.playwright).toBe(false);
    expect("getByAltText" in tab.playwright).toBe(false);
    expect("getByTitle" in tab.playwright).toBe(false);

    const first = tab.playwright.locator("button");
    const second = tab.playwright.getByText("Continue");
    const combined = first.and(second);
    expect(typeof combined.click).toBe("function");
    expect(proto(combined)).toEqual([
      "all", "allTextContents", "and", "check", "click", "constructor", "count",
      "dblclick", "downloadMedia", "evaluate", "fill", "filter", "first",
      "getAttribute", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId",
      "getByText", "innerText", "isEnabled", "isVisible", "last", "locator", "nth",
      "or", "press", "selectOption", "setChecked", "textContent", "type", "uncheck",
      "waitFor",
    ]);
    expect("selector" in combined).toBe(false);
    expect("clear" in combined).toBe(false);
    expect("isChecked" in combined).toBe(false);
    expect("isEditable" in combined).toBe(false);
    expect(typeof first.filter({ has: second }).click).toBe("function");
  });

  it("event result objects and the Browsers surface cover the documented contract", () => {
    expect(proto(new Browsers())).toEqual([
      "constructor", "get", "getDefault", "getForUrl", "list",
    ]);
    expect(proto(new PlaywrightDownload(Promise.resolve(null)))).toEqual(["constructor", "path"]);
    expect(proto(new PlaywrightFileChooser(aTab(), 1, false))).toEqual([
      "constructor", "isMultiple", "setFiles",
    ]);
  });

  it("Tab's instance fields carry no internal state", () => {
    const surface = surfaceOf(aTab());
    for (const f of FORBIDDEN_ON_TAB) {
      expect(surface.has(f), `Tab exposes the internal member "${f}", which the model can see and call`).toBe(false);
    }
  });

  it("Browser exposes neither conn nor info", () => {
    const surface = surfaceOf(aBrowser());
    for (const f of FORBIDDEN_ON_BROWSER) {
      expect(surface.has(f), `Browser exposes the internal member "${f}"`).toBe(false);
    }
  });

  it("Tab's public surface uses `id`, not `tabId`", () => {
    const surface = surfaceOf(aTab());
    expect(surface.has("id"), "the documented property is tab.id").toBe(true);
    expect(surface.has("tabId"), "there is no documented tabId").toBe(false);
  });

  it("Tabs and PlaywrightApi expose no tab or conn reference", () => {
    expect(surfaceOf(new Tabs(fakeConn))).not.toContain("conn");
    expect(surfaceOf(new PlaywrightApi(aTab()))).not.toContain("tab");
  });

  it("rejects Playwright calls the contract does not support, or whose shape is wrong", async () => {
    const playwright = new PlaywrightApi(aTab());
    expect(() => playwright.locator("")).toThrow(/requires a selector/);
    expect(() => playwright.frameLocator("")).toThrow(/requires a selector/);
    expect(() => playwright.getByTestId("")).toThrow(/requires a testId/);
    expect(() => playwright.waitForLoadState({ state: "networkidle" })).toThrow(
      /networkidle is not supported/,
    );
    await expect(playwright.waitForTimeout(1.5)).rejects.toThrow(/integer/);
    await expect(playwright.waitForURL("")).rejects.toThrow(/requires a URL/);
    await expect(
      playwright.waitForEvent("unsupported" as "download"),
    ).rejects.toThrow(/Unsupported Playwright event/);
    await expect(
      new PlaywrightFileChooser(aTab(), 1, true).setFiles([]),
    ).rejects.toThrow(/at least one file path/);
    await expect(
      new PlaywrightFileChooser(aTab(), 1, true).setFiles("relative.txt"),
    ).rejects.toThrow(/must be absolute/);
  });

  it("supports regex text matching, and refuses to combine Locators across Tabs", () => {
    const firstApi = new PlaywrightApi(new Tab(fakeConn, 1));
    const secondApi = new PlaywrightApi(new Tab(fakeConn, 2));
    expect(firstApi.getByText(/continue/i).selector).toContain("/continue/i");
    expect(firstApi.getByRole("button", { name: /save/i }).selector).toContain("/save/i");
    expect(() => firstApi.locator("button").and(secondApi.locator("button"))).toThrow(
      /same tab/,
    );
    expect(() => firstApi.locator("form").filter({
      has: secondApi.locator("input"),
    })).toThrow(/same tab/);
  });

  it("CUA and DOM CUA follow api.json's parameter semantics and validate before executing", async () => {
    const tab = aTab();
    await expect(tab.cua.click({ x: Number.NaN, y: 1 })).rejects.toThrow(/requires x and y/);
    await expect(
      tab.cua.click({ button: "left", x: 1, y: 2 } as never),
    ).rejects.toThrow(/button must be an integer/);
    expect(
      () => tab.cua.scroll({ x: 1, y: 2 } as never),
    ).toThrow(/scrollX, and scrollY/);
    await expect(tab.cua.drag({ path: [] })).rejects.toThrow(/non-empty path/);
    await expect(
      tab.dom_cua.click({ node_id: 1 } as never),
    ).rejects.toThrow(/node_id must be a string/);
    await expect(
      tab.dom_cua.scroll({ scrollX: 1, scrollY: 2 } as never),
    ).rejects.toThrow(/requires x and y/);
  });
});
