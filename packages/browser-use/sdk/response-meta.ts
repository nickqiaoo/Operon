import type { BrowserDocumentationContext } from "./documentation.ts";
import type { BackendConnection } from "./transport.ts";

interface WireTab {
  active?: boolean;
  id: number;
  url?: string;
}

interface TabResponseContext {
  browserId: string;
  browserType: BrowserDocumentationContext["browserType"];
  conn: BackendConnection;
  tabId: number;
}

interface PendingBrowserCommand {
  context: TabResponseContext;
  finalize: boolean;
}

interface NodeReplLike {
  addAfterSubmittedCodeHook?(hook: {
    run(): Promise<void> | void;
    timeoutMs?: number;
  }): (() => void) | void;
  setResponseMeta?(meta: Record<string, unknown>): void;
}

const contexts = new WeakMap<object, TabResponseContext>();
const installed = new WeakSet<object>();
let pendingFinalization: PendingBrowserCommand | undefined;
let pendingMutation: PendingBrowserCommand | undefined;

function nodeRepl(): NodeReplLike | undefined {
  return (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
}

function backendName(type: BrowserDocumentationContext["browserType"]): "chrome" | "iab" | "cdp" {
  return type === "extension" ? "chrome" : type;
}

function sanitizedUrl(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function pageOrigin(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return undefined;
  }
}

function browserMeta(
  context: Pick<TabResponseContext, "browserId" | "browserType">,
  details: Record<string, unknown> = {},
  currentUrl?: string,
): Record<string, unknown> {
  const url = sanitizedUrl(currentUrl);
  return {
    "codex/browserUse": true,
    "codex/toolSurface": {
      backend: backendName(context.browserType),
      browserId: context.browserId,
      kind: "browserUse",
      ...details,
    },
    browser_use: url == null ? {} : { url },
  };
}

export function installBrowserResponseMetaHook(): void {
  const repl = nodeRepl();
  if (
    repl == null
    || typeof repl.addAfterSubmittedCodeHook !== "function"
    || installed.has(repl)
  ) {
    return;
  }
  installed.add(repl);
  repl.addAfterSubmittedCodeHook({
    timeoutMs: 10_000,
    run: flushBrowserResponseMeta,
  });
}

export function reportBrowserSelected(
  context: BrowserDocumentationContext,
): void {
  nodeRepl()?.setResponseMeta?.(
    browserMeta({
      browserId: context.browserId,
      browserType: context.browserType,
    }),
  );
}

export function registerTabResponseContext(
  tab: object,
  conn: BackendConnection,
  id: number,
  context: BrowserDocumentationContext | undefined,
): void {
  if (context == null) return;
  contexts.set(tab, {
    browserId: context.browserId,
    browserType: context.browserType,
    conn,
    tabId: id,
  });
}

export function recordTabMutation(tab: object): void {
  const context = contexts.get(tab);
  if (context == null) return;
  pendingMutation = { context, finalize: false };
}

export function recordTabsFinalized(
  conn: BackendConnection,
  context: BrowserDocumentationContext | undefined,
): void {
  if (context == null) return;
  pendingFinalization = {
    context: {
      browserId: context.browserId,
      browserType: context.browserType,
      conn,
      tabId: 0,
    },
    finalize: true,
  };
}

async function flushBrowserResponseMeta(): Promise<void> {
  const pending = pendingFinalization ?? pendingMutation;
  pendingFinalization = undefined;
  pendingMutation = undefined;
  if (pending == null) return;
  const repl = nodeRepl();
  if (repl?.setResponseMeta == null) return;
  if (pending.finalize) {
    repl.setResponseMeta(browserMeta(pending.context, {
      openTabIds: [],
      sessionEnded: true,
    }));
    return;
  }

  let tabs: WireTab[] = [];
  try {
    tabs = await pending.context.conn.sendSessionRequest<WireTab[]>("getTabs", {});
  } catch {
    // The selected tab can still be captured when listing fails.
  }
  const selected =
    tabs.find(({ id }) => id === pending.context.tabId)
    ?? tabs.find(({ active }) => active)
    ?? tabs[0];
  const tabId = selected?.id ?? pending.context.tabId;
  const openTabIds = tabs.map(({ id }) => String(id));
  let currentUrl = selected?.url;
  let screenshot:
    | { pageUrl?: string; tabId: string; url: string }
    | undefined;
  if (tabId > 0) {
    try {
      const [location, shot] = await Promise.all([
        pending.context.conn.sendSessionRequest<{
          result?: { value?: { href?: string } };
        }>("executeCdp", {
          target: { tabId },
          method: "Runtime.evaluate",
          commandParams: {
            expression: "({ href: window.location.href })",
            returnByValue: true,
          },
        }),
        pending.context.conn.sendSessionRequest<{ data?: string }>("executeCdp", {
          target: { tabId },
          method: "Page.captureScreenshot",
          commandParams: {
            captureBeyondViewport: false,
            format: "png",
          },
        }),
      ]);
      currentUrl = location.result?.value?.href ?? currentUrl;
      if (typeof shot.data === "string") {
        const origin = pageOrigin(currentUrl);
        screenshot = {
          tabId: String(tabId),
          url: `data:image/png;base64,${shot.data}`,
          ...(origin == null ? {} : { pageUrl: origin }),
        };
      }
    } catch {
      // Response metadata is best-effort and must not fail the tool call.
    }
  }
  repl.setResponseMeta(browserMeta(
    pending.context,
    {
      openTabIds,
      ...(screenshot == null ? {} : { screenshot }),
    },
    currentUrl,
  ));
}
