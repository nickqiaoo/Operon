/**
 * Operon's own browser SDK: the object layer the model sees.
 *
 * Why we wrote our own. The package this originally vendored is proprietary and
 * may not be redistributed with a product, which was a hard blocker on shipping
 * rather than a refactoring preference.
 *
 * Where the spec comes from. Two sources: the wire-oracle recordings, which
 * capture every frame the reference client sends (see README — that suite lives outside
 * this repository, with the reference client it needs),
 * and `docs/api.json`, a machine-readable interface contract. Do not guess by
 * reading a minified bundle. That was tried on the Computer Use side and produced
 * a self-consistent set of wrong answers: every test green, the product broken
 * (see `packages/computer-use/README.md`).
 *
 * ## Coverage
 *
 * Implemented and shipping: discovery, Agent, Browsers, Browser, Tabs and Tab,
 * the Playwright locator layer, CUA and DOM CUA, clipboard, content export,
 * dialogs, downloads, capabilities and user browser context. The production
 * runtime exports only `setupBrowserRuntime`; discovery, the transport and the
 * internal classes are never exposed to the model.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backendSocketDir, type BrowserCapability, type BrowserInfo } from "../wire.ts";
import { discoverBackends, type DiscoveredBackend } from "./discovery.ts";
import type { BackendConnection } from "./transport.ts";
import {
  FrameLocator,
  Locator,
  PlaywrightApi,
  PlaywrightDownload,
  PlaywrightFileChooser,
} from "./playwright.ts";
import {
  buildBrowserDocumentation,
  readBrowserDocument,
  readCapabilityDocumentation,
  supportsBrowserApiMember,
  type BrowserDocumentationContext,
} from "./documentation.ts";
import { CuaApi, DomCuaApi } from "./cua.ts";
import {
  ensureFileTransferAllowed,
  ensureHistoryAllowed,
  ensureNavigationAllowed,
} from "./security.ts";
import {
  attachTabCore,
  forgetPlaywrightInjection,
  cdp,
  evaluateOrThrow,
  onTabCdpEvent,
  onTabDownloadChange,
  sessionRequest,
  tabLocation,
  tabCore,
} from "./internals.ts";
import {
  installBrowserResponseMetaHook,
  recordTabMutation,
  recordTabsFinalized,
  registerTabResponseContext,
  reportBrowserSelected,
} from "./response-meta.ts";

/**
 * Global name the injected instance is attached to on the page.
 * Defined in `internals.ts`, alongside the injection expression and its cache
 * key; this is only a re-export.
 */
export { INJECTED_CONSTANT } from "./internals.ts";

export { BackendConnection, BrowserRpcError, connectPipe } from "./transport.ts";
export { discoverBackends, probeBackends, filterForSession } from "./discovery.ts";
export { SessionParamsSource, resolveSessionId, getTurnMetadata } from "./session.ts";
export { PlaywrightApi, Locator, FrameLocator, DEFAULT_TIMEOUT_MS, OOPIF_MARKER_ATTR, type ClickOptions, type MouseButton } from "./playwright.ts";
export { CuaApi, DomCuaApi, type CuaButton } from "./cua.ts";
export { BROWSER_DOCUMENTATION } from "./documentation.ts";

/**
 * Maps the `type` on the wire to the browser id the model sees: `extension`
 * becomes `chrome`, while `cdp` and `iab` pass through unchanged. The
 * model-facing vocabulary is `chrome`, `iab`, `cdp`.
 *
 * Skipping this mapping produces `No browser matching "chrome" (found:
 * extension, iab)`, which takes out every skill that names Chrome explicitly.
 */
const WIRE_TYPE_TO_BROWSER_ID: Record<string, string> = { cdp: "cdp", extension: "chrome", iab: "iab" };

/** The browser id vocabulary. `extension` is the client type a skill names when
 *  it wants Chrome. */
export const BROWSER_IDS = ["chrome", "extension", "iab", "cdp"] as const;

/** The tab shape a backend returns. Note it is a bare array, not `{tabs: […]}`. */
interface WireTabInfo {
  id: number;
  title?: string;
  url?: string;
  active?: boolean;
  owner?: string;
}

export interface TabInfo {
  id: string;
  title?: string;
  url?: string;
}

/**
 * A tab the user opened, as returned by `browser.user.openTabs()`.
 *
 * `id` is a string here for the same reason `TabInfo.id` is: the wire speaks
 * numbers, the model-facing layer speaks opaque strings. `claimTab` converts
 * back on the way in.
 */
export interface BrowserUserTabInfo {
  id: string;
  title?: string;
  url?: string;
  /** ISO 8601 timestamp for the last time the tab was opened or focused. */
  lastOpened?: string;
  /** User-visible tab group name when the tab belongs to one. */
  tabGroup?: string;
}

/** The user-tab shape a backend returns, with the wire's numeric id. */
interface WireUserTabInfo {
  id: number;
  title?: string;
  url?: string;
  lastOpened?: string;
  tabGroup?: string;
}

export interface TabClipboardEntry {
  base64?: string;
  mimeType: string;
  text?: string;
}

export interface TabClipboardItem {
  entries: TabClipboardEntry[];
  presentationStyle?: "unspecified" | "inline" | "attachment";
}

export interface TabDevLogEntry {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: string;
  timestamp: string;
  url?: string;
}

function validBase64(value: string): boolean {
  if (value.length === 0) return true;
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function normalizeClipboardItems(value: unknown): TabClipboardItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tab.clipboard.write requires at least one clipboard item");
  }
  return value.map((rawItem) => {
    if (
      rawItem == null
      || typeof rawItem !== "object"
      || !Array.isArray((rawItem as { entries?: unknown }).entries)
      || (rawItem as { entries: unknown[] }).entries.length === 0
    ) {
      throw new Error("tab.clipboard.write requires clipboard item entries");
    }
    const item = rawItem as {
      entries: unknown[];
      presentationStyle?: unknown;
    };
    if (
      item.presentationStyle !== undefined
      && item.presentationStyle !== "unspecified"
      && item.presentationStyle !== "inline"
      && item.presentationStyle !== "attachment"
    ) {
      throw new Error("tab.clipboard.write requires a valid presentationStyle");
    }
    const entries = item.entries.map((rawEntry): TabClipboardEntry => {
      if (rawEntry == null || typeof rawEntry !== "object") {
        throw new Error("tab.clipboard.write requires clipboard entry objects");
      }
      const entry = rawEntry as {
        base64?: unknown;
        mimeType?: unknown;
        text?: unknown;
      };
      if (typeof entry.mimeType !== "string" || entry.mimeType.length === 0) {
        throw new Error("tab.clipboard.write requires entry mimeType");
      }
      const hasText = typeof entry.text === "string";
      const hasBase64 = typeof entry.base64 === "string";
      if (hasText === hasBase64) {
        throw new Error(
          "tab.clipboard.write requires exactly one of entry text or base64",
        );
      }
      if (hasText) return { mimeType: entry.mimeType, text: entry.text as string };
      const base64 = entry.base64 as string;
      if (!validBase64(base64)) {
        throw new Error("tab.clipboard.write requires valid base64 entry data");
      }
      return { base64, mimeType: entry.mimeType };
    });
    return {
      entries,
      ...(item.presentationStyle === undefined
        ? {}
        : { presentationStyle: item.presentationStyle }),
    } as TabClipboardItem;
  });
}

const attachedTabIds = new WeakMap<BackendConnection, Set<number>>();

function attachedTabs(connection: BackendConnection): Set<number> {
  let ids = attachedTabIds.get(connection);
  if (ids == null) {
    ids = new Set();
    attachedTabIds.set(connection, ids);
  }
  return ids;
}

async function listedTab(tab: Tab): Promise<WireTabInfo | undefined> {
  const core = tabCore(tab);
  const tabs = await core.conn.sendSessionRequest<WireTabInfo[]>("getTabs", {});
  return tabs.find((item) => item.id === core.id);
}

function normalizedNavigationUrl(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function waitForTabNavigation(
  tab: Tab,
  options: {
    mainFrameId?: string;
    previousUrl?: string;
    targetUrl?: string;
    timeoutMs?: number;
  } = {},
): { promise: Promise<void>; cancel(): void } {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const previousUrl = normalizedNavigationUrl(options.previousUrl);
  const targetUrl = normalizedNavigationUrl(options.targetUrl);
  let navigationStarted = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (timer != null) clearTimeout(timer);
    unsubscribe();
    if (error == null) resolvePromise();
    else rejectPromise(error);
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  unsubscribe = onTabCdpEvent(tab, (event) => {
    if (event.method === "Page.navigationBlocked") {
      finish(new Error("Browser blocked the requested navigation"));
      return;
    }
    if (event.method === "Page.navigatedWithinDocument") {
      const url = (event.params as { url?: unknown } | undefined)?.url;
      const normalized = typeof url === "string" ? normalizedNavigationUrl(url) : undefined;
      if (
        targetUrl == null
        || normalized === targetUrl
        || (previousUrl != null && normalized != null && normalized !== previousUrl)
      ) {
        finish();
      }
      return;
    }
    if (event.method === "Page.frameStartedLoading") {
      const frameId = (event.params as { frameId?: unknown } | undefined)?.frameId;
      if (options.mainFrameId != null && frameId === options.mainFrameId) {
        navigationStarted = true;
      }
      return;
    }
    if (event.method === "Page.frameNavigated") {
      const frame = (event.params as {
        frame?: { id?: unknown; parentId?: unknown; url?: unknown };
      } | undefined)?.frame;
      const isMainFrame =
        options.mainFrameId != null
          ? frame?.id === options.mainFrameId
          : frame?.parentId == null;
      if (isMainFrame) {
        const url = typeof frame?.url === "string" ? normalizedNavigationUrl(frame.url) : undefined;
        if (
          targetUrl == null
          || url === targetUrl
          || (previousUrl != null && url != null && url !== previousUrl)
        ) {
          navigationStarted = true;
        }
      }
      return;
    }
    if (
      navigationStarted
      && (event.method === "Page.domContentEventFired" || event.method === "Page.loadEventFired")
    ) {
      finish();
    }
  });
  timer = setTimeout(
    () => finish(new Error("Timed out waiting for tab navigation")),
    timeoutMs,
  );
  return { promise, cancel: () => finish() };
}

async function screenshotScale(tab: Tab): Promise<number> {
  try {
    const result = await cdp<{ result?: { value?: unknown } }>(
      tab,
      "Runtime.evaluate",
      { expression: "window.devicePixelRatio", returnByValue: true },
    );
    const ratio = result?.result?.value;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      return 1 / ratio;
    }
  } catch {
    // Fall through to CSS pixel scale.
  }
  return 1;
}

async function viewportScreencast(
  tab: Tab,
  viewport: { clientHeight?: number; clientWidth?: number } | undefined,
): Promise<string | undefined> {
  const maxHeight =
    typeof viewport?.clientHeight === "number" && viewport.clientHeight > 0
      ? Math.round(viewport.clientHeight)
      : undefined;
  const maxWidth =
    typeof viewport?.clientWidth === "number" && viewport.clientWidth > 0
      ? Math.round(viewport.clientWidth)
      : undefined;
  let stopRequired = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = new Promise<{ data?: string; sessionId?: number } | undefined>((resolve) => {
    let settled = false;
    const finish = (value?: { data?: string; sessionId?: number }) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    unsubscribe = onTabCdpEvent(tab, (event) => {
      if (event.method === "Page.screencastVisibilityChanged") {
        const visible = (event.params as { visible?: unknown } | undefined)?.visible;
        if (visible === false) finish();
        return;
      }
      if (event.method !== "Page.screencastFrame") return;
      const params = event.params as {
        data?: unknown;
        sessionId?: unknown;
      } | undefined;
      finish({
        ...(typeof params?.data === "string" ? { data: params.data } : {}),
        ...(typeof params?.sessionId === "number" ? { sessionId: params.sessionId } : {}),
      });
    });
    timer = setTimeout(() => finish(), 2_000);
  });
  try {
    await cdp(tab, "Page.startScreencast", {
      everyNthFrame: 1,
      format: "jpeg",
      quality: 80,
      ...(maxHeight == null || maxWidth == null ? {} : { maxHeight, maxWidth }),
    });
    stopRequired = true;
    const result = await frame;
    if (result?.sessionId != null) {
      try {
        await cdp(tab, "Page.stopScreencast");
        stopRequired = false;
      } finally {
        await cdp(tab, "Page.screencastFrameAck", {
          sessionId: result.sessionId,
        }).catch(() => {});
      }
    }
    return result?.data;
  } catch {
    return undefined;
  } finally {
    if (timer != null) clearTimeout(timer);
    unsubscribe();
    if (stopRequired) await cdp(tab, "Page.stopScreencast").catch(() => {});
  }
}

export type JsDialog =
  | { type: "alert" | "beforeunload"; dismiss(): Promise<void> }
  | { type: "confirm"; accept(): Promise<void>; dismiss(): Promise<void> }
  | { type: "prompt"; accept(text: string): Promise<void>; dismiss(): Promise<void> };

function supportedCapabilityDescriptors(descriptors: BrowserCapability[]): BrowserCapability[] {
  return descriptors.filter((descriptor) => {
    const id = descriptor.id.toLowerCase();
    return id !== "browserauth" && id !== "webmcp";
  });
}

function capabilityCollection(
  descriptors: BrowserCapability[],
  scope: "browser" | "tab",
): {
  list(): Promise<BrowserCapability[]>;
  get(id: string): Promise<unknown>;
} {
  const supported = supportedCapabilityDescriptors(descriptors);
  const byId = new Map(supported.map((descriptor) => [descriptor.id, descriptor]));
  return {
    list: async () => supported.map((descriptor) => ({ ...descriptor })),
    get: async (id: string) => {
      const descriptor = byId.get(id);
      if (descriptor == null) throw new Error(`Unknown browser capability "${id}"`);
      return {
        documentation: async () => await readCapabilityDocumentation(scope, descriptor),
      };
    },
  };
}

const filteredSurfaceCache = new WeakMap<object, Map<string, object>>();
const filteredSurfaceTargets = new WeakMap<object, object>();

function apiInterfaceFor(value: object): string | undefined {
  if (value instanceof PlaywrightApi) return "PlaywrightAPI";
  if (value instanceof Locator) return "PlaywrightLocator";
  if (value instanceof FrameLocator) return "PlaywrightFrameLocator";
  if (value instanceof PlaywrightDownload) return "PlaywrightDownload";
  if (value instanceof PlaywrightFileChooser) return "PlaywrightFileChooser";
  if (value instanceof CuaApi) return "CUAAPI";
  if (value instanceof DomCuaApi) return "DomCUAAPI";
  if (value instanceof Tab) return "Tab";
  if (value instanceof Tabs) return "Tabs";
  if (value instanceof Browser) return "Browser";
  return undefined;
}

function unwrapApiArgument(value: unknown): unknown {
  if (typeof value !== "object" || value == null) return value;
  const raw = filteredSurfaceTargets.get(value);
  if (raw != null) return raw;
  if (Array.isArray(value)) return value.map(unwrapApiArgument);
  if (
    Reflect.getPrototypeOf(value) === null
    || Object.prototype.toString.call(value) === "[object Object]"
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, unwrapApiArgument(entry)]),
    );
  }
  return value;
}

function wrapApiResult(
  value: unknown,
  context: BrowserDocumentationContext | undefined,
): unknown {
  if (context == null || value == null) return value;
  if (value instanceof Promise) {
    return value.then((resolved) => wrapApiResult(resolved, context));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => wrapApiResult(entry, context));
  }
  if (typeof value !== "object") return value;
  const raw = filteredSurfaceTargets.get(value) ?? value;
  const interfaceName = apiInterfaceFor(raw);
  return interfaceName == null
    ? value
    : filteredApiSurface(raw, interfaceName, context);
}

function filteredApiSurface<T extends object>(
  target: T,
  interfaceName: string,
  context: BrowserDocumentationContext | undefined,
): T {
  if (context == null) return target;
  const rawTarget = (filteredSurfaceTargets.get(target) ?? target) as T;
  const cacheKey = `${context.browserId}:${context.browserType}:${interfaceName}`;
  const cached = filteredSurfaceCache.get(rawTarget)?.get(cacheKey);
  if (cached != null) return cached as T;
  const boundMethods = new Map<PropertyKey, unknown>();
  const isHidden = (property: PropertyKey): boolean =>
    typeof property === "string"
    && property !== "constructor"
    && !supportsBrowserApiMember(context, `${interfaceName}.${property}`);
  const prototype = Reflect.getPrototypeOf(rawTarget);
  const filteredPrototype = prototype == null
    ? null
    : new Proxy(prototype, {
        get(protoTarget, property, receiver) {
          if (isHidden(property)) return undefined;
          return Reflect.get(protoTarget, property, receiver);
        },
        has(protoTarget, property) {
          return !isHidden(property) && Reflect.has(protoTarget, property);
        },
        ownKeys(protoTarget) {
          return Reflect.ownKeys(protoTarget).filter((property) => !isHidden(property));
        },
        getOwnPropertyDescriptor(protoTarget, property) {
          if (isHidden(property)) return undefined;
          return Reflect.getOwnPropertyDescriptor(protoTarget, property);
        },
      });
  const proxy = new Proxy(rawTarget, {
    get(surface, property) {
      if (isHidden(property)) return undefined;
      const value = Reflect.get(surface, property, surface);
      if (typeof value !== "function") return wrapApiResult(value, context);
      if (!boundMethods.has(property)) {
        boundMethods.set(property, (...args: unknown[]) =>
          wrapApiResult(
            Reflect.apply(value, surface, args.map(unwrapApiArgument)),
            context,
          ));
      }
      return boundMethods.get(property);
    },
    has(surface, property) {
      return !isHidden(property) && Reflect.has(surface, property);
    },
    ownKeys(surface) {
      return Reflect.ownKeys(surface).filter((property) => !isHidden(property));
    },
    getOwnPropertyDescriptor(surface, property) {
      if (isHidden(property)) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(surface, property);
      if (descriptor == null || !("value" in descriptor)) return descriptor;
      return {
        ...descriptor,
        value: wrapApiResult(descriptor.value, context),
      };
    },
    getPrototypeOf() {
      return filteredPrototype;
    },
  });
  let cachedByInterface = filteredSurfaceCache.get(rawTarget);
  if (cachedByInterface == null) {
    cachedByInterface = new Map();
    filteredSurfaceCache.set(rawTarget, cachedByInterface);
  }
  cachedByInterface.set(cacheKey, proxy);
  filteredSurfaceTargets.set(proxy, rawTarget);
  return proxy;
}

async function downloadFromTab(
  tab: Tab,
  url: string,
  options: { timeout?: number; timeoutMs?: number } = {},
): Promise<{ id: string; filename: string; status: string; url: string }> {
  const timeoutMs = options.timeoutMs ?? options.timeout ?? 60_000;
  await ensureFileTransferAllowed((await tab.url()) ?? "", "download");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for download of ${url}`));
    }, timeoutMs);
    const off = onTabDownloadChange(tab, (change) => {
      if (change.url !== url) return;
      if (
        change.status !== "complete"
        && change.status !== "canceled"
        && change.status !== "failed"
      ) return;
      clearTimeout(timer);
      off();
      if (change.status === "complete") resolve(change);
      else reject(new Error(`Download ${change.status}: ${url}`));
    });
    void sessionRequest(tab, "allowDownload", { url }).catch((error: unknown) => {
      clearTimeout(timer);
      off();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function gsuiteExportUrl(input: string, type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx"): string {
  const url = new URL(input);
  const match = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/u);
  if (url.hostname !== "docs.google.com" || match == null) {
    throw new Error("exportGsuite requires an open Google Docs, Sheets, or Slides document");
  }
  const [, product, id] = match;
  const supported =
    product === "document"
      ? new Set(["pdf", "docx", "md"])
      : product === "spreadsheets"
        ? new Set(["pdf", "xlsx", "csv"])
        : new Set(["pdf", "pptx"]);
  if (!supported.has(type)) {
    throw new Error(`Google ${product} cannot be exported as ${type}`);
  }
  if (product === "presentation") {
    return `https://docs.google.com/presentation/d/${id}/export/${type}`;
  }
  const format = type === "md" ? "txt" : type;
  return `https://docs.google.com/${product}/d/${id}/export?format=${format}`;
}

function exportFileStem(title: string | undefined): string {
  const cleaned = (title ?? "Asset")
    .replace(/[/\\?%*|"<>:]/gu, "_")
    .trim();
  return cleaned.length === 0 ? "ExportedContent" : cleaned;
}

/**
 * A handle on one tab: everything the model can see lives on this class, and
 * nothing else does.
 *
 * Do not add internal methods here. The transport (`conn`), injection state and
 * CDP primitives all live in `./internals.ts`, with state in a WeakMap and
 * cross-module internals as module-level functions. This is not tidiness: a model
 * holding a tab will run
 * `Object.getOwnPropertyNames(Object.getPrototypeOf(tab))` to see what is there,
 * and one did exactly that, found our internal `evaluateOrThrow` and started
 * calling it as API, bypassing every check and breaking the moment we renamed it.
 * TypeScript's `private` is compile-time only and does not stop enumeration; `#`
 * and WeakMap are private at runtime.
 *
 * The shape is pinned by `../sdk-shape.test.ts`.
 *
 * The CDP sequence `goto` emits is recorded and its order is part of the
 * contract (asserted by the wire-oracle recordings): the client's navigation state
 * machine depends on the backend attaching first, then enabling each domain, and
 * only navigating once it has the frame tree.
 */
export class Tab {
  /**
   * The property is `tab.id`. It was briefly named `tabId` here, which diverged
   * from the documented API and left anyone following the docs with undefined.
   *
   * On the wire it is still `tabId` (`{target:{tabId}}`, `{tabId, status}`),
   * because that is the backend's contract. Do not rename that along with it;
   * the wire-oracle recordings guard it.
   */
  readonly id: string;
  /** `tab.playwright.locator(...)`: the locator layer, and the main path. See
   *  ./playwright.ts */
  readonly playwright: PlaywrightApi;
  /** `tab.cua.click({x,y})`: the screenshot-and-coordinates fallback surface, see
   *  ./cua.ts. Prefer a locator whenever one will do. */
  readonly cua: CuaApi;
  /** `tab.dom_cua`: the node-id flavour, for pages where the DOM is reachable but
   *  its semantics are poor. See ./cua.ts */
  readonly dom_cua: DomCuaApi;
  readonly capabilities: {
    list(): Promise<BrowserCapability[]>;
    get(id: string): Promise<unknown>;
  };

  /**
   * Clipboard. Permission has to be granted first: in headless and automated
   * environments `navigator.clipboard` is blocked by default, and without the
   * grant `readText()` throws NotAllowedError.
   */
  readonly clipboard = {
    writeText: async (text: string): Promise<void> => {
      if (typeof text !== "string") {
        throw new Error("tab.clipboard.writeText requires text");
      }
      await this.#grantClipboard();
      await evaluateOrThrow(this, `navigator.clipboard.writeText(${JSON.stringify(text)})`);
    },
    readText: async (): Promise<string> => {
      await this.#grantClipboard();
      return (await evaluateOrThrow<string>(this, "navigator.clipboard.readText()")) ?? "";
    },
    read: async (): Promise<TabClipboardItem[]> => {
      await this.#grantClipboard();
      const items = await evaluateOrThrow<Array<{
        presentationStyle?: "unspecified" | "inline" | "attachment";
        entries: Array<{ mimeType: string; text?: string; base64?: string }>;
      }>>(this, `(async () => {
        const out = [];
        for (const item of await navigator.clipboard.read()) {
          const entries = [];
          for (const mimeType of item.types) {
            const blob = await item.getType(mimeType);
            if (
              mimeType.startsWith("text/") ||
              mimeType === "application/json" ||
              mimeType === "application/xml" ||
              mimeType === "image/svg+xml"
            ) {
              entries.push({ mimeType, text: await blob.text() });
            } else {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              let binary = "";
              for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              }
              entries.push({ mimeType, base64: btoa(binary) });
            }
          }
          out.push({ presentationStyle: item.presentationStyle, entries });
        }
        return out;
      })()`);
      return (items ?? []).map((item) => ({
        ...(item.presentationStyle != null ? { presentationStyle: item.presentationStyle } : {}),
        entries: item.entries.map((entry) => ({ ...entry })),
      }));
    },
    write: async (items: TabClipboardItem[]): Promise<void> => {
      const normalized = normalizeClipboardItems(items);
      await this.#grantClipboard();
      const serialised = normalized.map((item) => ({
        ...(item.presentationStyle == null
          ? {}
          : { presentationStyle: item.presentationStyle }),
        entries: item.entries.map((entry) => ({ ...entry })),
      }));
      await evaluateOrThrow(this, `(async () => {
        const items = ${JSON.stringify(serialised)}.map((item) => {
          const payload = {};
          for (const entry of item.entries) {
            if (entry.text !== undefined) {
              payload[entry.mimeType] = new Blob([entry.text], { type: entry.mimeType });
            } else {
              const binary = atob(entry.base64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              payload[entry.mimeType] = new Blob([bytes], { type: entry.mimeType });
            }
          }
          return new ClipboardItem(
            payload,
            item.presentationStyle == null
              ? undefined
              : { presentationStyle: item.presentationStyle },
          );
        });
        await navigator.clipboard.write(items);
      })()`);
    },
  };

  readonly content = {
    export: async (): Promise<string> => {
      const tempRoot =
        (globalThis as { nodeRepl?: { tmpDir?: string } }).nodeRepl?.tmpDir
        ?? tmpdir();
      const root = join(tempRoot, "browser-use", "exports");
      await mkdir(root, { recursive: true });
      const path = join(
        root,
        `${exportFileStem(await this.title())}-${randomUUID()}.html`,
      );
      const html = await this.playwright.evaluate<string>(
        "document.documentElement.outerHTML",
      );
      await writeFile(path, html, "utf8");
      return path;
    },
    exportGsuite: async (type: "pdf" | "md" | "xlsx" | "csv" | "docx" | "pptx"): Promise<string> => {
      const current = await this.url();
      if (current == null) throw new Error("The tab has no URL to export");
      const exportUrl = gsuiteExportUrl(current, type);
      const result = await downloadFromTab(this, exportUrl);
      return result.filename;
    },
  };

  readonly dev = {
    logs: async (options: {
      filter?: string;
      levels?: Array<"debug" | "info" | "log" | "warn" | "warning" | "error">;
      limit?: number;
    } = {}): Promise<TabDevLogEntry[]> => {
      if (options == null || Array.isArray(options) || typeof options !== "object") {
        throw new Error("tab.dev.logs expects an options object");
      }
      if (options.filter != null && typeof options.filter !== "string") {
        throw new Error("tab.dev.logs received an invalid filter");
      }
      const acceptedLevels = new Set([
        "debug",
        "info",
        "log",
        "warn",
        "warning",
        "error",
      ]);
      if (
        options.levels != null
        && (
          !Array.isArray(options.levels)
          || options.levels.length === 0
          || options.levels.some((level) => !acceptedLevels.has(level))
        )
      ) {
        throw new Error("tab.dev.logs received invalid levels");
      }
      if (
        options.limit != null
        && (!Number.isInteger(options.limit) || options.limit <= 0)
      ) {
        throw new Error("tab.dev.logs received an invalid limit");
      }
      this.#ensureConsoleCapture();
      const levels = options.levels?.map((level) => level === "warning" ? "warn" : level);
      const filtered = tabCore(this).consoleLogs.filter((entry) =>
        (levels == null || levels.includes(entry.level)) &&
        (options.filter == null || entry.message.includes(options.filter))
      );
      return filtered.slice(-(options.limit ?? 100));
    },
  };

  constructor(
    conn: BackendConnection,
    id: number,
    capabilityDescriptors: BrowserCapability[] = [],
    surfaceContext?: BrowserDocumentationContext,
  ) {
    this.id = String(id);
    // This has to come first: every method below reaches the connection and id
    // through core.
    attachTabCore(this, {
      conn,
      id,
      playwrightInjected: false,
      clipboardGranted: false,
      injectedTargets: new Set(),
      consoleLogs: [],
    });
    registerTabResponseContext(this, conn, id, surfaceContext);
    this.capabilities = capabilityCollection(capabilityDescriptors, "tab");
    this.playwright = new PlaywrightApi(this);
    this.cua = filteredApiSurface(new CuaApi(this), "CUAAPI", surfaceContext);
    this.dom_cua = filteredApiSurface(new DomCuaApi(this), "DomCUAAPI", surfaceContext);
  }

  /** The first step of `goto` in the recording: have the backend attach the
   *  debugger to this tab. */
  async #attach(): Promise<void> {
    await sessionRequest<void>(this, "attach", {});
    const core = tabCore(this);
    attachedTabs(core.conn).add(core.id);
  }

  /**
   * Enable the CDP domains: the sequence the recording sends before `goto`.
   * The reference sends `Page.enable` twice, here and again before navigating.
   * Once is enough: it is idempotent, and the recorded assertions check
   * containment rather than counts.
   */
  /**
   * Consume `Fetch.requestPaused`. Without this, every real page hangs.
   *
   * Once `Fetch.enable` is on, Chrome pauses the document response and waits to
   * be continued. Without that, `Page.navigate` never returns: about:blank comes
   * back instantly while any real URL simply sits there. That is where
   * `../sdk-locator-real.test.ts` came from.
   *
   * Frame-by-frame differential testing cannot catch this: the frames we sent
   * were identical, and the difference was that the reference *consumed* this
   * event channel and we did not. Identical frames are not identical behaviour,
   * which is exactly why testing against a real browser is not optional.
   *
   * Nothing is rewritten here, only continued. Fetch stays enabled so document
   * status codes and downloads can be observed later.
   */
  #ensureFetchContinue(): void {
    const core = tabCore(this);
    if (core.fetchUnsubscribe != null) return;
    core.fetchUnsubscribe = onTabCdpEvent(this, (e) => {
      if (e.method !== "Fetch.requestPaused") return;
      if (e.source.tabId !== tabCore(this).id) return;
      const requestId = (e.params as { requestId?: string } | undefined)?.requestId;
      if (requestId == null) return;
      // Continue. continueRequest covers both the request and response stages.
      void cdp(this, "Fetch.continueRequest", { requestId }).catch(() => {
        /* The request may already be gone, or the tab closed. Failing to continue
           it must not blow up the caller. */
      });
    });
  }

  async #enableDomains(): Promise<void> {
    await cdp(this, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp(this, "Page.enable");
    await cdp(this, "Runtime.enable");
    this.#ensureConsoleCapture();
    // Install the continue listener before enabling. The other order leaves a
    // window between enable and the first requestPaused, and that request stays
    // paused forever.
    this.#ensureFetchContinue();
    // The dialog listener also has to be installed before navigating: an `alert()`
    // can fire during load, and an unhandled one wedges everything after it.
    this.#ensureDialogHandling();
    // Intercept only the response stage for documents: this observes navigation
    // results, it is not a general-purpose proxy.
    await cdp(this, "Fetch.enable", {
      patterns: [{ requestStage: "Response", resourceType: "Document" }],
    });
    // Auto-attach to iframe targets; locators inside cross-origin iframes depend
    // on it.
    await cdp(this, "Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
      filter: [{ type: "iframe", exclude: false }],
    });
  }

  /** Main frame id. The recording always reads it before navigating, since the
   *  navigation state machine compares it against frameNavigated events. */
  async #mainFrameId(): Promise<string | undefined> {
    const tree = await cdp<{ frameTree?: { frame?: { id?: string } } }>(this, "Page.getFrameTree");
    return tree?.frameTree?.frame?.id;
  }

  /**
   * The exact sequence `goto` emits, as recorded and guarded by
   * the wire-oracle and sdk-differential suites:
   *
   *   attach
   *   → Emulation.setFocusEmulationEnabled → Page.enable → Runtime.enable
   *   → Fetch.enable → Target.setAutoAttach
   *   -> Runtime.evaluate({href, readyState})    <- do not omit this one
   *   → Page.getFrameTree → Page.navigate
   *
   * That `Runtime.evaluate` probes the current state before navigating: whether
   * the page is already at the target URL and whether it is still loading, which
   * is what decides how the navigation state machine proceeds. An early version
   * omitted it and the differential test caught it immediately.
   */
  /**
   * `timeoutMs` bounds the wait for the new document, not the load itself; the
   * wait ends at `DOMContentLoaded`. The 10s default is short for app-shell
   * sites (x.com, youtube.com) on a slow link, so callers that know they are
   * opening one should raise it rather than eat a spurious timeout.
   */
  async goto(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("tab.goto requires a url");
    }
    if (options.timeoutMs != null && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("tab.goto timeoutMs must be a positive number of milliseconds");
    }
    await ensureNavigationAllowed(url);
    await this.#attach();
    await this.#enableDomains();
    const previous = await tabLocation(this);
    const mainFrameId = await this.#mainFrameId();
    const navigation = waitForTabNavigation(this, {
      mainFrameId,
      previousUrl: previous.href,
      targetUrl: url,
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      const result = await cdp<{ errorText?: string }>(this, "Page.navigate", { url });
      if (typeof result?.errorText === "string" && result.errorText !== "") {
        throw new Error(`Browser could not open the requested page: ${result.errorText}`);
      }
      await navigation.promise;
      // The new document has none of the injected helper, so the caches saying it is there now
      // describe the page we just left.
      forgetPlaywrightInjection(this);
      recordTabMutation(this);
    } finally {
      navigation.cancel();
    }
  }

  /** Current browser-client screenshot path: JPEG, CSS-pixel coordinates and screencast fallback. */
  async screenshot(options: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  } = {}): Promise<Uint8Array> {
    if (options == null || Array.isArray(options) || typeof options !== "object") {
      throw new Error("tab.screenshot expects an options object");
    }
    if (options.fullPage !== undefined && typeof options.fullPage !== "boolean") {
      throw new Error("tab.screenshot fullPage must be a boolean");
    }
    const params: Record<string, unknown> = {
      format: "jpeg",
      quality: 80,
    };
    const scale = await screenshotScale(this);
    if (options.clip != null) {
      const { x, y, width, height } = options.clip;
      if (![x, y, width, height].every((value) => Number.isFinite(value))) {
        throw new Error("tab.screenshot clip requires x, y, width, and height");
      }
      if (width <= 0 || height <= 0) {
        throw new Error("tab_screenshot crop width and height must be positive");
      }
      params.captureBeyondViewport = true;
      params.clip = { x, y, width, height, scale };
    } else if (options.fullPage === true) {
      const metrics = await cdp<{
        cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
      }>(this, "Page.getLayoutMetrics");
      const size = metrics?.cssContentSize;
      if (
        size == null
        || typeof size.width !== "number"
        || typeof size.height !== "number"
        || size.width <= 0
        || size.height <= 0
      ) {
        throw new Error(
          "Page.getLayoutMetrics returned no valid cssContentSize for full-page screenshot.",
        );
      }
      params.captureBeyondViewport = true;
      params.clip = {
        x: size.x ?? 0,
        y: size.y ?? 0,
        width: size.width,
        height: size.height,
        scale,
      };
    } else {
      const metrics = await cdp<{
        cssVisualViewport?: {
          clientHeight?: number;
          clientWidth?: number;
          pageX?: number;
          pageY?: number;
        };
      }>(this, "Page.getLayoutMetrics");
      const viewport = metrics?.cssVisualViewport;
      const frame = await viewportScreencast(this, viewport);
      if (frame != null) return Buffer.from(frame, "base64");
      if (
        viewport == null
        || typeof viewport.clientWidth !== "number"
        || typeof viewport.clientHeight !== "number"
      ) {
        throw new Error("Page.getLayoutMetrics returned no valid cssVisualViewport.");
      }
      params.clip = {
        x: viewport.pageX ?? 0,
        y: viewport.pageY ?? 0,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale,
      };
    }
    const r = await cdp<{ data?: string }>(this, "Page.captureScreenshot", params);
    if (typeof r?.data !== "string") throw new Error("Page.captureScreenshot returned no data");
    return Buffer.from(r.data, "base64");
  }

  async title(): Promise<string | undefined> {
    return (await listedTab(this))?.title;
  }

  async url(): Promise<string | undefined> {
    return (await listedTab(this))?.url;
  }

  /** Back and forward, via Page.getNavigationHistory for the entryId that
   *  `Page.navigateToHistoryEntry` requires. */
  async #historyGo(delta: number): Promise<void> {
    const h = await cdp<{ currentIndex?: number; entries?: Array<{ id: number }> }>(this, "Page.getNavigationHistory");
    const idx = (h?.currentIndex ?? 0) + delta;
    const entry = h?.entries?.[idx];
    if (entry == null) {
      throw new Error(delta < 0
        ? "Cannot navigate back: no previous page in history."
        : "Cannot navigate forward: no next page in history.");
    }
    const navigation = waitForTabNavigation(this);
    try {
      await cdp(this, "Page.navigateToHistoryEntry", { entryId: entry.id });
      await navigation.promise;
      // The new document has none of the injected helper, so the caches saying it is there now
      // describe the page we just left.
      forgetPlaywrightInjection(this);
      recordTabMutation(this);
    } finally {
      navigation.cancel();
    }
  }
  back(): Promise<void> {
    return this.#historyGo(-1);
  }
  forward(): Promise<void> {
    return this.#historyGo(1);
  }
  async reload(): Promise<void> {
    const navigation = waitForTabNavigation(this);
    try {
      await cdp<void>(this, "Page.reload", {});
      await navigation.promise;
      // The new document has none of the injected helper, so the caches saying it is there now
      // describe the page we just left.
      forgetPlaywrightInjection(this);
      recordTabMutation(this);
    } finally {
      navigation.cancel();
    }
  }

  /**
   * JavaScript dialogs (alert, confirm, prompt). Leaving one unhandled wedges
   * everything after it.
   *
   * An `alert()` stops the page's JavaScript where it stands, and every
   * subsequent `Runtime.evaluate` stops returning. This installs a listener and
   * keeps the active dialog around, for the caller to handle explicitly through
   * `getJsDialog()`.
   */
  #ensureDialogHandling(): void {
    const core = tabCore(this);
    if (core.dialogUnsubscribe != null) return;
    core.dialogUnsubscribe = onTabCdpEvent(this, (e) => {
      if (e.source.tabId !== tabCore(this).id) return;
      if (e.method === "Page.javascriptDialogClosed") {
        core.activeDialog = undefined;
        return;
      }
      if (e.method !== "Page.javascriptDialogOpening") return;
      const p = (e.params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
      const info = { type: p.type ?? "alert", message: p.message ?? "", defaultPrompt: p.defaultPrompt };
      core.activeDialog = info;
    });
  }

  async #resolveDialog(
    expected: { type: string; message: string; defaultPrompt?: string },
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    const core = tabCore(this);
    if (core.activeDialog !== expected) {
      throw new Error("The JavaScript dialog is no longer active");
    }
    await cdp(this, "Page.handleJavaScriptDialog", {
      accept,
      ...(promptText != null ? { promptText } : {}),
    });
    if (core.activeDialog === expected) core.activeDialog = undefined;
    recordTabMutation(this);
  }

  async #grantClipboard(): Promise<void> {
    const core = tabCore(this);
    if (core.clipboardGranted) return;
    const loc = await tabLocation(this);
    if (loc.href) {
      await cdp(this, "Browser.grantPermissions", {
        origin: new URL(loc.href).origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      }).catch(() => {
        /* Some backends do not grant the Browser domain. Let a later call report
           the real error rather than guessing here. */
      });
    }
    core.clipboardGranted = true;
  }

  /**
   * Mark what a tab is for: `deliverable` is a result meant for the user, and
   * `handoff` needs the user to take over, a sign-in for example. The host decides
   * how to present it, and the IAB backend leaves marked tabs alone at cleanup.
   */
  #markTab(status: "deliverable" | "handoff"): Promise<void> {
    return sessionRequest<void>(this, "markTab", { status });
  }
  markDeliverable(): Promise<void> {
    return this.#markTab("deliverable");
  }
  markHandoff(): Promise<void> {
    return this.#markTab("handoff");
  }

  async close(): Promise<void> {
    await sessionRequest<void>(this, "closeTab", {});
    const core = tabCore(this);
    attachedTabs(core.conn).delete(core.id);
    recordTabMutation(this);
  }

  getJsDialog(): Promise<JsDialog | undefined> {
    this.#ensureDialogHandling();
    const active = tabCore(this).activeDialog;
    if (active == null) return Promise.resolve(undefined);
    const dismiss = () => this.#resolveDialog(active, false);
    if (active.type === "prompt") {
      return Promise.resolve({
        type: "prompt",
        accept: (text: string) => this.#resolveDialog(active, true, text),
        dismiss,
      });
    }
    if (active.type === "confirm") {
      return Promise.resolve({
        type: "confirm",
        accept: () => this.#resolveDialog(active, true),
        dismiss,
      });
    }
    return Promise.resolve({
      type: active.type === "beforeunload" ? "beforeunload" : "alert",
      dismiss,
    });
  }

  #ensureConsoleCapture(): void {
    const core = tabCore(this);
    if (core.consoleUnsubscribe != null) return;
    core.consoleUnsubscribe = onTabCdpEvent(this, (event) => {
      if (event.source.tabId !== core.id || event.method !== "Runtime.consoleAPICalled") return;
      const params = (event.params ?? {}) as {
        type?: string;
        timestamp?: number;
        args?: Array<{ value?: unknown; description?: string }>;
        stackTrace?: { callFrames?: Array<{ url?: string }> };
      };
      const rawLevel = params.type === "warning" ? "warn" : params.type;
      const level =
        rawLevel === "debug" || rawLevel === "info" || rawLevel === "warn" || rawLevel === "error"
          ? rawLevel
          : "log";
      const message = (params.args ?? []).map((arg) =>
        arg.value !== undefined
          ? typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value)
          : arg.description ?? ""
      ).join(" ");
      const source = params.stackTrace?.callFrames?.find((frame) => frame.url)?.url;
      core.consoleLogs.push({
        level,
        message,
        timestamp: new Date(params.timestamp ?? Date.now()).toISOString(),
        ...(source != null ? { url: source } : {}),
      });
      if (core.consoleLogs.length > 1_000) core.consoleLogs.splice(0, core.consoleLogs.length - 1_000);
    });
  }
}

/** `browser.tabs` */
export class Tabs {
  /** `#` rather than `private`: the latter leaves an ordinary property at runtime
   *  that a model can enumerate. See the note at the top of the Tab class. */
  readonly #conn: BackendConnection;
  readonly #tabCapabilities: BrowserCapability[];
  readonly #surfaceContext: BrowserDocumentationContext | undefined;

  constructor(
    conn: BackendConnection,
    tabCapabilities: BrowserCapability[] = [],
    surfaceContext?: BrowserDocumentationContext,
  ) {
    this.#conn = conn;
    this.#tabCapabilities = supportedCapabilityDescriptors(tabCapabilities);
    this.#surfaceContext = surfaceContext;
  }

  #tab(id: number): Tab {
    return filteredApiSurface(
      new Tab(this.#conn, id, this.#tabCapabilities, this.#surfaceContext),
      "Tab",
      this.#surfaceContext,
    );
  }

  /**
   * The backend returns a bare array, not `{tabs: […]}`. Wrapping it makes the
   * client fail with `.map is not a function`; there is a note about this in
   * IabBackend too.
   *
   * What comes back is the tabs *this session* holds, not every tab in the browser.
   */
  async list(): Promise<TabInfo[]> {
    const tabs = await this.#wireTabs();
    return tabs.map((tab) => ({
      id: String(tab.id),
      ...(tab.title != null ? { title: tab.title } : {}),
      ...(tab.url != null ? { url: tab.url } : {}),
    }));
  }

  async new(): Promise<Tab> {
    const info = await this.#conn.sendSessionRequest<WireTabInfo>("createTab", {});
    if (typeof info?.id !== "number") throw new Error("createTab did not return a tab id");
    return this.#tab(info.id);
  }

  async get(id: string | number): Promise<Tab> {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("tabs.get requires a tab id");
    }
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) throw new Error(`Invalid tab id ${String(id)}`);
    const tabs = await this.#wireTabs();
    if (!tabs.some((tab) => tab.id === numericId)) {
      throw new Error(`No tab with id ${String(id)} in this session`);
    }
    return this.#tab(numericId);
  }

  /**
   * Wrap up: close the tabs this session no longer needs, keeping the ones named
   * in `keep`. Tabs marked `deliverable` or `handoff` may be exempted by the
   * backend, since those are meant for the user.
   */
  async finalize(options: {
    keep?: Array<{ tab: string | Tab | TabInfo; status: "handoff" | "deliverable" }>;
  } = {}): Promise<void> {
    if (options == null || Array.isArray(options) || typeof options !== "object") {
      throw new Error("browser.tabs.finalize expects an options object");
    }
    const entries = options.keep ?? [];
    if (!Array.isArray(entries)) {
      throw new Error("browser.tabs.finalize keep must be an array");
    }
    const keep = entries.map((entry) => {
      if (entry == null || typeof entry !== "object" || !("tab" in entry)) {
        throw new Error(
          "browser.tabs.finalize keep entries must be objects like { tab, status }; do not pass a Tab or tab id directly",
        );
      }
      const tab = entry.tab;
      const id =
        typeof tab === "string"
          ? tab
          : typeof tab === "object" && tab != null && typeof tab.id === "string"
            ? tab.id
            : undefined;
      if (id == null || id.length === 0) {
        throw new Error("browser.tabs.finalize received an empty or invalid tab id");
      }
      if (entry.status !== "handoff" && entry.status !== "deliverable") {
        throw new Error(`browser.tabs.finalize received invalid status ${String(entry.status)}`);
      }
      return { tabId: Number(id), status: entry.status };
    });
    const attached = attachedTabs(this.#conn);
    await Promise.all(
      [...attached].map((tabId) =>
        this.#conn.sendSessionRequest<void>("detach", { tabId }),
      ),
    );
    attached.clear();
    await this.#conn.sendSessionRequest<void>("finalizeTabs", { keep });
    recordTabsFinalized(this.#conn, this.#surfaceContext);
  }

  /** The currently selected tab, or undefined when there is none. */
  async selected(): Promise<Tab | undefined> {
    const tabs = await this.#wireTabs();
    const active = tabs.find((t) => t.active) ?? tabs[0];
    return active ? this.#tab(active.id) : undefined;
  }

  async content(options: {
    urls: string[];
    contentType: "html" | "text" | "domSnapshot";
    timeoutMs?: number;
  }): Promise<Array<{ content: string | null; title: string | null; url: string }>> {
    if (
      options == null
      || !Array.isArray(options.urls)
      || options.urls.some((url) => typeof url !== "string")
    ) {
      throw new Error("tabs.content requires an array of URLs");
    }
    if (!["html", "text", "domSnapshot"].includes(options.contentType)) {
      throw new Error('tabs.content contentType must be "html", "text", or "domSnapshot"');
    }
    if (options.timeoutMs != null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("tabs.content timeoutMs must be a positive integer");
    }
    if (options.urls.length === 0) return [];
    for (const url of options.urls) await ensureNavigationAllowed(url);
    const result = await this.#conn.sendSessionRequest<{
      results?: Array<{ content: string | null; title: string | null; url: string }>;
    }>("executeUnhandledCommand", {
      ...(this.#surfaceContext == null
        ? {}
        : { browser_id: this.#surfaceContext.browserId }),
      type: "tabs_content",
      urls: options.urls,
      content_type: options.contentType,
      ...(options.timeoutMs == null ? {} : { timeout_ms: options.timeoutMs }),
    });
    return result.results ?? [];
  }

  #wireTabs(): Promise<WireTabInfo[]> {
    return this.#conn.sendSessionRequest<WireTabInfo[]>("getTabs", {});
  }
}

const browserConnections = new WeakMap<Browser, BackendConnection>();

function browserConnection(browser: Browser): BackendConnection {
  const connection = browserConnections.get(browser);
  if (connection == null) throw new Error("Browser is not initialised (internal)");
  return connection;
}

/**
 * Convert a model-facing tab id back to the positive integer the wire expects,
 * or `undefined` when it is not one. The IAB backend coerces numeric strings
 * itself; the extension backend does not, so never send it a string.
 */
function wireTabId(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The Browser returned by `agent.browsers.get(...)`. */
export class Browser {
  readonly browserId: string;
  readonly tabs: Tabs;
  readonly capabilities: {
    list(): Promise<BrowserCapability[]>;
    get(id: string): Promise<unknown>;
  };
  readonly user: {
    openTabs(): Promise<BrowserUserTabInfo[]>;
    history(options?: {
      limit?: number;
      queries?: string[];
      from?: string | Date;
      to?: string | Date;
    }): Promise<Array<{
      url: string;
      title?: string;
      dateVisited: string;
    }>>;
    claimTab(tab: string | number | { id: string | number }): Promise<Tab>;
  };
  /**
   * Neither `conn` (the raw transport) nor `info` may be an ordinary property.
   * The documented own-property set is `[browserId, capabilities, tabs, user]`.
   * `#` is private at runtime; `private` is not.
   */
  readonly #info: BrowserInfo;
  readonly #documentationContext: BrowserDocumentationContext;

  constructor(backend: DiscoveredBackend) {
    browserConnections.set(this, backend.conn);
    this.#info = backend.info;
    const browserCapabilities = supportedCapabilityDescriptors(
      backend.info.capabilities?.browser ?? [],
    );
    const tabCapabilities = supportedCapabilityDescriptors(backend.info.capabilities?.tab ?? []);
    this.#documentationContext = {
      browserId: backend.info.id,
      browserName: backend.info.name,
      browserType: backend.info.type,
      ...(backend.info.apiSupportOverrides == null
        ? {}
        : { apiSupportOverrides: backend.info.apiSupportOverrides }),
      browserCapabilities,
      tabCapabilities,
    };
    reportBrowserSelected(this.#documentationContext);
    this.browserId = backend.info.id;
    this.capabilities = this.#createCapabilities(browserCapabilities);
    this.tabs = filteredApiSurface(
      new Tabs(backend.conn, tabCapabilities, this.#documentationContext),
      "Tabs",
      this.#documentationContext,
    );
    const rawUser = {
      openTabs: async (): Promise<BrowserUserTabInfo[]> => {
        const tabs = await browserConnection(this).sendSessionRequest<WireUserTabInfo[]>(
          "getUserTabs",
          {},
        );
        // Stringify like `tabs.list()` does. Passing the wire's number straight
        // through made `claimTab(tab)` reject the very object `openTabs()`
        // handed out.
        return (tabs ?? []).map((tab) => ({
          ...tab,
          id: String(tab.id),
        }));
      },
      history: async (options: {
        limit?: number;
        queries?: string[];
        from?: string | Date;
        to?: string | Date;
      } = {}): Promise<Array<{
        url: string;
        title?: string;
        dateVisited: string;
      }>> => {
        if (options == null || Array.isArray(options) || typeof options !== "object") {
          throw new Error("browser.user.history expects an options object");
        }
        if (
          options.queries != null
          && (
            !Array.isArray(options.queries)
            || options.queries.length === 0
            || options.queries.some((query) => typeof query !== "string")
          )
        ) {
          throw new Error("browser.user.history received invalid queries");
        }
        if (
          options.limit != null
          && (!Number.isInteger(options.limit) || options.limit <= 0)
        ) {
          throw new Error("browser.user.history received an invalid limit");
        }
        const date = (value: string | Date | undefined, name: "from" | "to") => {
          if (value == null) return undefined;
          const parsed = value instanceof Date ? value : new Date(value);
          if (Number.isNaN(parsed.getTime())) {
            throw new Error(`browser.user.history received an invalid ${name} date`);
          }
          return parsed.toISOString();
        };
        const params = {
          ...(options.queries == null ? {} : { queries: options.queries }),
          ...(options.limit == null ? {} : { limit: options.limit }),
          ...(options.from == null ? {} : { from: date(options.from, "from") }),
          ...(options.to == null ? {} : { to: date(options.to, "to") }),
        };
        await ensureHistoryAllowed(params);
        return await browserConnection(this).sendSessionRequest("getUserHistory", params);
      },
      claimTab: async (tab: string | number | { id: string | number }): Promise<Tab> => {
        const raw =
          typeof tab === "string" || typeof tab === "number"
            ? tab
            : typeof tab === "object" && tab != null
              ? tab.id
              : undefined;
        // The wire wants a positive integer. The extension backend rejects a
        // numeric string outright, so convert here rather than hoping the
        // backend is lenient.
        const id = wireTabId(raw);
        if (id == null) {
          throw new Error(
            "browser.user.claimTab expects a tab returned by browser.user.openTabs() or a tab id",
          );
        }
        const connection = browserConnection(this);
        const claimed = await connection.sendSessionRequest<{ id?: number }>(
          "claimUserTab",
          { tabId: id },
        );
        if (typeof claimed?.id !== "number") {
          throw new Error(`claimUserTab did not return a tab id for ${id}`);
        }
        return filteredApiSurface(
          new Tab(connection, claimed.id, tabCapabilities, this.#documentationContext),
          "Tab",
          this.#documentationContext,
        );
      },
    };
    this.user = filteredApiSurface(rawUser, "BrowserUser", this.#documentationContext);
  }

  /**
   * The model reads this before its first use; a skill's bootstrap is literally
   * `nodeRepl.write(await iab.documentation())`. Its contents have to match the
   * real API surface in `sdk/`; see the note in documentation.ts.
   */
  documentation(): Promise<string> {
    return buildBrowserDocumentation(this.#documentationContext);
  }

  #createCapabilities(descriptors: BrowserCapability[]): Browser["capabilities"] {
    return {
      list: async (): Promise<BrowserCapability[]> =>
        descriptors.map((descriptor) => ({ ...descriptor })),
      get: async (id: string): Promise<unknown> => {
      const descriptor = descriptors.find((item) => item.id === id);
      if (descriptor == null) throw new Error(`Unknown browser capability "${id}"`);
      if (id === "visibility") {
        return {
          documentation: async () =>
            await readCapabilityDocumentation("browser", descriptor),
          set: (visible: boolean): Promise<void> =>
            browserConnection(this).sendSessionRequest<void>("executeUnhandledCommand", {
              type: "browser_visibility_set",
              visible,
            }),
          get: async (): Promise<boolean> => {
            const result = await browserConnection(this).sendSessionRequest<{ visible?: boolean }>(
              "executeUnhandledCommand",
              { type: "browser_visibility_get" },
            );
            return result?.visible === true;
          },
        };
      }
      if (id === "viewport") {
        return {
          documentation: async () =>
            await readCapabilityDocumentation("browser", descriptor),
          set: (size: { width: number; height: number }): Promise<void> => {
            if (
              size == null
              || !Number.isInteger(size.width)
              || size.width <= 0
              || !Number.isInteger(size.height)
              || size.height <= 0
            ) {
              throw new Error("viewport.set requires positive integer width and height");
            }
            return browserConnection(this).sendSessionRequest<void>("executeUnhandledCommand", {
              type: "browser_viewport_set",
              width: size.width,
              height: size.height,
            });
          },
          reset: (): Promise<void> =>
            browserConnection(this).sendSessionRequest<void>("executeUnhandledCommand", {
              type: "browser_viewport_reset",
            }),
        };
      }
      return {
        documentation: async () =>
          await readCapabilityDocumentation("browser", descriptor),
      };
      },
    };
  }

  nameSession(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("browser.nameSession requires a name");
    return browserConnection(this).sendSessionRequest<void>("nameSession", { name: trimmed });
  }
}

/** Cleanup entry point for tests and hosts. The production runtime does not
 *  export it, so it is not part of the model-visible Browser API. */
export function closeBrowser(browser: Browser): void {
  browserConnection(browser).close();
  browserConnections.delete(browser);
}

/** `agent.browsers` */
export class Browsers {
  readonly #socketDir: string | undefined;

  constructor(socketDir?: string) {
    this.#socketDir = socketDir;
  }

  /**
   * List the info of every available backend.
   * Discovery has already filtered IAB backends by session and build flavour, and
   * closed the connections that did not match. Extension and cdp backends pass
   * through untouched.
   */
  async list(): Promise<BrowserInfo[]> {
    const found = await discoverBackends(this.#socketDir);
    const infos = found.map((b) => b.info);
    for (const b of found) b.conn.close();
    return infos;
  }

  /**
   * Look up by backend id, browser id or client type. A skill names Chrome as
   * `"extension"`, and `"chrome"` is kept as a compatible alias.
   */
  async get(idOrType: string): Promise<Browser> {
    const found = await discoverBackends(this.#socketDir);
    const match =
      found.find((b) => b.info.id === idOrType) ??
      found.find((b) => WIRE_TYPE_TO_BROWSER_ID[b.info.type] === idOrType) ??
      found.find((b) => b.info.type === idOrType);
    if (!match) {
      const available = found.map((b) => b.info.type);
      for (const b of found) b.conn.close();
      throw new Error(`No browser matching "${idOrType}" (available: ${available.join(", ") || "none"})`);
    }
    for (const b of found) if (b !== match) b.conn.close(); // Do not keep unselected connections.
    return new Browser(match);
  }

  /**
   * Pick a browser by explainable routing: local and file URLs prefer IAB;
   * otherwise match against the URLs of existing tabs, in order of exact,
   * origin plus pathname, hostname, then hostname hierarchy. At equal rank IAB
   * wins, then the extension, then the default.
   */
  async getForUrl(url: string): Promise<Browser> {
    const found = await discoverBackends(this.#socketDir);
    if (found.length === 0) throw new Error("No browser is available");
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      for (const backend of found) backend.conn.close();
      throw new Error(`Invalid browser URL: ${url}`);
    }
    let selected: DiscoveredBackend | undefined;
    if (found.length === 1) {
      selected = found[0];
    } else if (isLocalBrowserUrl(target)) {
      selected = found.find((backend) => backend.info.type === "iab");
    }
    if (selected == null) {
      const candidates = await Promise.all(
        found.map(async (backend) => ({
          backend,
          openTabUrls: await openTabUrls(backend),
        })),
      );
      for (const mode of ["exact", "originPathname", "hostname", "hostnameHierarchy"] as const) {
        const matches = candidates.filter(({ openTabUrls: urls }) =>
          urls.some((candidate) => browserUrlMatches(candidate, target, mode))
        );
        selected = preferBrowser(matches.map(({ backend }) => backend));
        if (selected != null) break;
      }
    }
    selected ??= preferBrowser(found);
    if (selected == null) {
      for (const backend of found) backend.conn.close();
      throw new Error("No browser is available");
    }
    for (const backend of found) if (backend !== selected) backend.conn.close();
    return new Browser(selected);
  }

  /** Default browser preference: IAB, then the extension, then anything else. */
  async getDefault(): Promise<Browser> {
    const found = await discoverBackends(this.#socketDir);
    const selected = preferBrowser(found);
    if (selected == null) throw new Error("No browser is available");
    for (const backend of found) if (backend !== selected) backend.conn.close();
    return new Browser(selected);
  }
}

const OPEN_TABS_TIMEOUT_MS = 1_000;

function preferBrowser(backends: DiscoveredBackend[]): DiscoveredBackend | undefined {
  return backends.find(({ info }) => info.type === "iab")
    ?? backends.find(({ info }) => info.type === "extension")
    ?? backends[0];
}

async function openTabUrls(backend: DiscoveredBackend): Promise<string[]> {
  const calls =
    backend.info.type === "extension"
      ? [backend.conn.sendSessionRequest<WireTabInfo[]>("getUserTabs", {}, OPEN_TABS_TIMEOUT_MS)]
      : backend.info.type === "iab"
        ? [
            backend.conn.sendSessionRequest<WireTabInfo[]>("getTabs", {}, OPEN_TABS_TIMEOUT_MS),
            backend.conn.sendSessionRequest<WireTabInfo[]>("getUserTabs", {}, OPEN_TABS_TIMEOUT_MS),
          ]
        : [];
  if (calls.length === 0) return [];
  try {
    return (await Promise.all(calls))
      .flat()
      .flatMap(({ url }) => typeof url === "string" ? [url] : []);
  } catch {
    return [];
  }
}

function isLocalBrowserUrl(url: URL): boolean {
  if (url.protocol === "file:") return true;
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "::1"
    || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

function normalizedBrowserUrl(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.href;
}

function hostnameHierarchyMatches(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/\.$/u, "");
  const b = right.toLowerCase().replace(/\.$/u, "");
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.includes(".") && isIP(shorter) === 0 && longer.endsWith(`.${shorter}`);
}

function browserUrlMatches(
  candidate: string,
  target: URL,
  mode: "exact" | "originPathname" | "hostname" | "hostnameHierarchy",
): boolean {
  let open: URL;
  try {
    open = new URL(candidate);
  } catch {
    return false;
  }
  switch (mode) {
    case "exact":
      return normalizedBrowserUrl(open) === normalizedBrowserUrl(target);
    case "originPathname":
      return open.origin === target.origin && open.pathname === target.pathname;
    case "hostname":
      return open.hostname === target.hostname;
    case "hostnameHierarchy":
      return hostnameHierarchyMatches(open.hostname, target.hostname);
  }
}

export interface Agent {
  browsers: Browsers;
  /** `agent.documentation.get(name)` reads one packaged document by name. */
  documentation: { get(name: string): Promise<string> };
}

/**
 * `setupBrowserRuntime({globals})` attaches `agent` to the given globals.
 *
 * This is exactly how a skill's bootstrap uses it (see `skill/SKILL.md`):
 * ```js
 * const { setupBrowserRuntime } = await import(clientPath);
 * await setupBrowserRuntime({ globals: globalThis });
 * globalThis.iab = await agent.browsers.get("iab");
 * ```
 */
export async function setupBrowserRuntime(options: { globals: Record<string, unknown>; socketDir?: string }): Promise<Agent> {
  installBrowserResponseMetaHook();
  const agent: Agent = {
    browsers: new Browsers(options.socketDir ?? backendSocketDir()),
    documentation: { get: readBrowserDocument },
  };
  options.globals.agent = agent;
  return agent;
}
