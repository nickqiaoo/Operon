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
  /** Identity of the conversation currently executing; see the kernel façade. */
  contextKey?: object;
}

/**
 * What is waiting to be reported at the end of a conversation's exec.
 *
 * Per conversation: this module is loaded once per kernel and shared by every
 * conversation. When the pending commands were module variables and the hook
 * was installed once per `nodeRepl` (which is also one object per kernel), only
 * the first conversation to use the browser ever flushed — and it flushed the
 * others' pending commands too, screenshotting their tabs into its own result.
 */
interface ConversationPending {
  finalization?: PendingBrowserCommand;
  mutation?: PendingBrowserCommand;
  hookInstalled?: boolean;
}

const contexts = new WeakMap<object, TabResponseContext>();
const pendingByConversation = new WeakMap<object, ConversationPending>();
/** For code running with no `nodeRepl` at all. */
const noReplKey = {};

function nodeRepl(): NodeReplLike | undefined {
  return (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
}

/** The conversation executing now; a host without per-context keys (a
 *  single-context embedding) is one conversation per `nodeRepl`. */
function conversationKey(): object {
  const repl = nodeRepl();
  const key = repl?.contextKey;
  return key != null && typeof key === "object" ? key : (repl ?? noReplKey);
}

function conversationPending(): ConversationPending {
  const key = conversationKey();
  let pending = pendingByConversation.get(key);
  if (pending == null) {
    pending = {};
    pendingByConversation.set(key, pending);
  }
  return pending;
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
  if (repl == null || typeof repl.addAfterSubmittedCodeHook !== "function") return;
  // Once per conversation: the kernel runs a hook only for the context that
  // registered it, and forgets it when that context is disposed.
  const pending = conversationPending();
  if (pending.hookInstalled) return;
  pending.hookInstalled = true;
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
  conversationPending().mutation = { context, finalize: false };
}

export function recordTabsFinalized(
  conn: BackendConnection,
  context: BrowserDocumentationContext | undefined,
): void {
  if (context == null) return;
  conversationPending().finalization = {
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
  const queued = conversationPending();
  const pending = queued.finalization ?? queued.mutation;
  queued.finalization = undefined;
  queued.mutation = undefined;
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
