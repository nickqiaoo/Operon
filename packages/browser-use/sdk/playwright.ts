/**
 * The Playwright locator layer of operon's browser SDK.
 *
 * The division of labour is the thing to understand here. Finding elements,
 * deciding visibility, actionability and hit testing all happen inside
 * Playwright's own injectedScript, which is Apache-2.0 and used as-is (see
 * `../playwright-injected.test.ts`). What this file provides is the shell that
 * drives it:
 *
 *   1. Wrap an expression as "check the injection, run the prelude, evaluate"
 *      and send it to the page.
 *   2. Retry until the deadline, since an element may not have rendered yet, may
 *      be covered, or may still be moving.
 *   3. Turn coordinates into real input via `Input.dispatchMouseEvent`.
 *
 * Playwright's own *driver* is deliberately not used. It expects a browser-level
 * CDP endpoint, and this backend offers tab-scoped RPC instead: the extension
 * path goes through `chrome.debugger`, which is per-tab by construction and
 * cannot produce a browser-level endpoint.
 *
 * ## What is covered, honestly
 *
 * Selector resolution within one origin and target, strict mode with a
 * visibility fallback, retries, click, fill, textContent, isVisible, count and
 * boundingBox, same-origin iframes and recursive OOPIF target resolution,
 * coordinate-chain conversion, and full actionability and hit checks. The
 * model-facing surface exposes only the documented members; the extra helpers
 * exist for testing the implementation.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Tab } from "./index.ts";
import {
  INJECTED_CONSTANT,
  INJECTED_OPTIONS,
  OOPIF_MARKER_ATTR,
  attachTarget,
  cdp,
  injectPlaywright,
  injectPlaywrightInTarget,
  oopifTargetIdForMarker,
  onTabCdpEvent,
  onTabDownloadChange,
  waitForTabLoadState,
} from "./internals.ts";
import { recordTabMutation } from "./response-meta.ts";
import { ensureFileTransferAllowed } from "./security.ts";

/**
 * These constants live in `internals.ts`, which imports nothing above it, so
 * anything can reach them safely.
 *
 * They used to be defined here and imported back by index.ts, which was a
 * circular import: a const referenced across the cycle is still undefined at
 * module evaluation time. That produced a genuinely confusing failure, where
 * `${OOPIF_MARKER_ATTR}` inside `FRAME_PRELUDE` interpolated to the literal
 * string `undefined`, iframes were tagged with an attribute actually named
 * "undefined", CDP's querySelector could not find it, and the result was
 * nodeId: 0.
 *
 * The internals layer straightens the dependency direction out:
 * internals <- playwright/cua <- index, with no cycle. The re-exports here only
 * keep existing import paths working.
 */
export { OOPIF_MARKER_ATTR };

// ---- Protocol constants ----

/** Retry interval, in milliseconds. */
const RETRY_INTERVAL_MS = 100;
/** Default timeout for a locator operation, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Three scroll-into-view fallbacks, tried in order: some layouts do not scroll
 *  correctly on the first attempt. */
const SCROLL_FALLBACKS = [
  { block: "center", inline: "nearest" },
  { block: "end", inline: "end" },
  { block: "start", inline: "start" },
] as const;

/** Error text used when the injection has gone missing, which happens after the
 *  page navigates. */
const INJECTED_MISSING = "Browser Use Playwright injected helper is missing";

export type MouseButton = "left" | "right" | "middle";

/**
 * CDP parameters for the common keys. `Input.dispatchKeyEvent` needs `key`,
 * `code` and `windowsVirtualKeyCode` to agree; without the virtual key code many
 * pages' keydown handlers do not recognise the event at all. Printable
 * characters also need an extra `char` event.
 */
const KEY_MAP: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
};

/** Only right and middle are recognised; anything else is left. */
function buttonName(b: MouseButton | undefined): MouseButton {
  return b === "right" || b === "middle" ? b : "left";
}

/** CDP's `buttons` bitmask: left 1, right 2, middle 4. Note these are not 0/1/2. */
function buttonMask(b: MouseButton): number {
  switch (b) {
    case "right":
      return 2;
    case "middle":
      return 4;
    default:
      return 1;
  }
}

/**
 * The strict-mode prelude, with a visibility fallback: one match wins outright;
 * several matches of which exactly one is visible resolve to that one; anything
 * else raises a strict-mode violation.
 *
 * That fallback matters on real pages, which routinely carry hidden duplicate
 * nodes such as templates or `display:none` mobile copies. Pure strict mode
 * would report those as ambiguous.
 */
const PRELUDE = `
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }
  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }
  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];
  throw injected.strictModeViolationError(parsedSelector, matches);
}`;

/**
 * Global name of the injected instance on the page.
 * It must match the main frame's injection in both name and options. Both come
 * from `internals.ts`; duplicating either here guarantees that one day only one
 * of the two copies gets updated.
 */
const INJECTED = INJECTED_CONSTANT;

/**
 * The frame-traversal prelude. All same-origin iframe support lives here, as
 * recursion inside the page.
 *
 * Playwright selectors mark frame boundaries with `internal:control=enter-frame`,
 * for example `iframe#pay >> internal:control=enter-frame >> internal:role=button`.
 * Traversal walks those boundaries in the page itself:
 *
 * - `injectedForWindow` builds another InjectedScript inside the iframe's window
 *   using `rootInjected.constructor`. That avoids re-injecting 191KB and reuses
 *   the existing instance's constructor instead.
 * - `selectorScopeFor` descends segment by segment and returns the innermost
 *   `{injected, root, parsed}` along with the `frameChain`.
 * - `prepareFrameChainForPointerAction` converts click coordinates back up the
 *   chain into main-frame viewport coordinates, since
 *   `Input.dispatchMouseEvent` only understands those, scrolling each level into
 *   view and checking visibility on the way.
 *   The conversion has to account for `scaleX`/`scaleY` on iframes scaled by a
 *   CSS transform, and for `clientLeft`/`clientTop` borders.
 *
 * A cross-origin iframe never reaches this path: `frameElement.contentWindow`
 * throws. The prelude returns a marker instead, and the layer above resolves the
 * CDP target or the exact frame execution context, which is what makes recursive
 * OOPIF support work.
 */
const FRAME_PRELUDE = `
const OOPIF_MARKER_ATTR = ${JSON.stringify(OOPIF_MARKER_ATTR)};
const OOPIF_MARKER = "operon-oopif";

function injectedForWindow(rootInjected, targetWindow) {
  if (!targetWindow) throw new Error("Frame window is not available");
  if (targetWindow.${INJECTED}) return targetWindow.${INJECTED};
  // Reuse the root's constructor rather than re-injecting the whole blob.
  targetWindow.${INJECTED} = new rootInjected.constructor(targetWindow, ${JSON.stringify(INJECTED_OPTIONS)});
  return targetWindow.${INJECTED};
}

const unsupportedFrameAccessMessage =
  "Cross-origin or out-of-process iframes are not supported by this runtime selector path";

function sliceParsedSelector(parsedSelector, startIndex, endIndex) {
  const sliced = { ...parsedSelector, parts: parsedSelector.parts.slice(startIndex, endIndex) };
  if (parsedSelector.capture === undefined) {
    delete sliced.capture;
  } else if (parsedSelector.capture >= startIndex && parsedSelector.capture < endIndex) {
    sliced.capture = parsedSelector.capture - startIndex;
  } else {
    delete sliced.capture;
  }
  return sliced;
}

function frameContentGeometry(frameElement) {
  const rect = frameElement.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error("Frame does not have an actionable bounding box");
  const offsetWidth = Number(frameElement.offsetWidth) || rect.width;
  const offsetHeight = Number(frameElement.offsetHeight) || rect.height;
  const clientWidth = Number(frameElement.clientWidth);
  const clientHeight = Number(frameElement.clientHeight);
  if (offsetWidth <= 0 || offsetHeight <= 0 || clientWidth <= 0 || clientHeight <= 0)
    throw new Error("Frame does not have an actionable bounding box");
  const scaleX = rect.width / offsetWidth;
  const scaleY = rect.height / offsetHeight;
  return {
    left: rect.left + (Number(frameElement.clientLeft) || 0) * scaleX,
    top: rect.top + (Number(frameElement.clientTop) || 0) * scaleY,
    scaleX, scaleY,
  };
}

function pointThroughFrameElement(point, frameElement) {
  const g = frameContentGeometry(frameElement);
  return { x: g.left + point.x * g.scaleX, y: g.top + point.y * g.scaleY };
}

function oopifGeometry(frameChain, frameElement) {
  const g = frameContentGeometry(frameElement);
  const origin = prepareFrameChainForPointerAction(
    frameChain,
    { x: g.left, y: g.top },
    { block: "center", inline: "nearest" },
  );
  const xUnit = prepareFrameChainForPointerAction(
    frameChain,
    { x: g.left + g.scaleX, y: g.top },
    { block: "center", inline: "nearest" },
  );
  const yUnit = prepareFrameChainForPointerAction(
    frameChain,
    { x: g.left, y: g.top + g.scaleY },
    { block: "center", inline: "nearest" },
  );
  return {
    x: origin.x,
    y: origin.y,
    scaleX: xUnit.x - origin.x,
    scaleY: yUnit.y - origin.y,
  };
}

// Walk back outward, converting coordinates level by level into the main frame.
function prepareFrameChainForPointerAction(frameChain, point, scrollAlignment) {
  const block = (scrollAlignment && scrollAlignment.block) || "center";
  const inline = (scrollAlignment && scrollAlignment.inline) || "nearest";
  let currentPoint = point;
  for (const frameScope of frameChain.slice().reverse()) {
    frameScope.element.scrollIntoView({ block, inline, behavior: "instant" });
    const state = frameScope.injected.elementState(frameScope.element, "visible");
    if (state.received === "error:notconnected") throw new Error("Frame is not connected");
    if (!state.matches) throw new Error("Frame is not visible");
    currentPoint = pointThroughFrameElement(currentPoint, frameScope.element);
  }
  return currentPoint;
}

function selectorScopeFor(initialInjected, parsedSelector) {
  let currentRoot = document;
  let currentInjected = initialInjected;
  const frameChain = [];
  let partStart = 0;
  while (true) {
    const enterFrameIndex = parsedSelector.parts.findIndex(
      (part, index) => index >= partStart && part.name === "internal:control" && part.body === "enter-frame"
    );
    if (enterFrameIndex === -1) {
      return {
        frameChain,
        injected: currentInjected,
        root: currentRoot,
        parsed: sliceParsedSelector(parsedSelector, partStart, parsedSelector.parts.length),
        prepareFrameChainForPointerAction: (point, scrollAlignment) =>
          prepareFrameChainForPointerAction(frameChain, point, scrollAlignment),
      };
    }
    const frameSelector = sliceParsedSelector(parsedSelector, partStart, enterFrameIndex);
    const frameElement = querySelectorStrictWithVisibleFallback(currentInjected, frameSelector, currentRoot);
    if (!frameElement) return null;
    const tagName = String(frameElement.localName || frameElement.tagName || "").toLowerCase();
    if (tagName !== "iframe" && tagName !== "frame")
      throw new Error("internal:control=enter-frame must target a frame element");
    let frameWindow, frameDocument;
    try {
      frameWindow = frameElement.contentWindow;
      frameDocument = frameElement.contentDocument || (frameWindow && frameWindow.document);
    } catch {
      frameWindow = null; frameDocument = null;   // Cross-origin: contentWindow access throws.
    }
    if (!frameWindow || !frameDocument) {
      // Cross-origin or OOPIF: unreachable from inside the page. Tag it so the CDP
      // side can find it again, and hand the remaining selector to the layer
      // above rather than failing here.
      const marker = OOPIF_MARKER + ":" + String(Date.now()) + ":" + Math.random().toString(16).slice(2);
      frameElement.setAttribute(OOPIF_MARKER_ATTR, marker);
      return {
        oopif: {
          marker,
          geometry: oopifGeometry(frameChain, frameElement),
          // The rest of the selector, after enter-frame, resolves inside that target.
          remaining: sliceParsedSelector(parsedSelector, enterFrameIndex + 1, parsedSelector.parts.length),
        },
      };
    }
    frameChain.push({ element: frameElement, injected: currentInjected });
    currentRoot = frameDocument;
    currentInjected = injectedForWindow(initialInjected, frameWindow);
    partStart = enterFrameIndex + 1;
  }
}`;


/**
 * The wrapper shape used when evaluating with the Playwright injection in a
 * target:
 * ```js
 * (() => {
 *   if (!window.__codexPlaywrightInjected) { throw new Error("<wk>"); }
 *   return (<expression>);
 * })()
 * ```
 * The injection check is not optional. A navigation wipes the injection, and
 * without this check the failure surfaces as `undefined is not an object`, which
 * says nothing, instead of "the injection is gone, re-inject it".
 */
function wrapInjected(expression: string): string {
  return `(() => {
  if (!window.${INJECTED}) {
    throw new Error(${JSON.stringify(INJECTED_MISSING)});
  }
  return (${expression});
})()`;
}

/**
 * The action to run once the element resolves; its value comes back through
 * `returnByValue`.
 *
 * It must be `async`, because the body awaits
 * `injected.checkElementStates(...)`, whose stability check spans frames. An
 * earlier version used a non-async arrow, which made `await` a SyntaxError, so
 * every evaluate threw and the retry loop read that as "not ready yet" until it
 * timed out. Worse, the negative cases (the ones expecting a rejection) then
 * passed for the wrong reason: they were seeing a syntax error, not
 * actionability refusing. Only the positive cases against a real browser
 * exposed it.
 */
function selectorExpression(selector: string, body: string): string {
  return wrapInjected(`(async () => {
  ${PRELUDE}
  ${FRAME_PRELUDE}
  const rootInjected = window.${INJECTED};
  const parsedFull = rootInjected.parseSelector(${JSON.stringify(selector)});
  // Descend through internal:control=enter-frame to the target frame; with no
  // frames, scope.root is the document.
  const scope = selectorScopeFor(rootInjected, parsedFull);
  if (!scope) return { found: false };
  // Hit a cross-origin iframe: report it so the SDK can attach to that target and
  // resolve the remainder there.
  if (scope.oopif) return { oopif: scope.oopif };
  const injected = scope.injected;
  const parsed = scope.parsed;
  const element = querySelectorStrictWithVisibleFallback(injected, parsed, scope.root);
  ${body}
})()`);
}

/**
 * Resolve an already-parsed remainder of a selector inside an OOPIF.
 *
 * The remainder must not be serialised back to a string and re-parsed: the bodies
 * of `internal:*` segments are normalised in Playwright's parsed structure, and a
 * round trip through text loses that. Feed the parsed object straight back in.
 */
function parsedSelectorExpression(parsed: unknown, body: string): string {
  return wrapInjected(`(async () => {
  ${PRELUDE}
  ${FRAME_PRELUDE}
  const rootInjected = window.${INJECTED};
  const parsedFull = ${JSON.stringify(parsed)};
  const scope = selectorScopeFor(rootInjected, parsedFull);
  if (!scope) return { found: false };
  if (scope.oopif) return { oopif: scope.oopif };
  const injected = scope.injected;
  const parsed = scope.parsed;
  const element = querySelectorStrictWithVisibleFallback(injected, parsed, scope.root);
  ${body}
})()`);
}

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  timeout?: number;
  timeoutMs?: number;
  force?: boolean;
  modifiers?: KeyboardModifier[];
}

export interface LocatorOptions {
  timeout?: number;
  timeoutMs?: number;
}

export type KeyboardModifier =
  | "Alt"
  | "Control"
  | "ControlOrMeta"
  | "Meta"
  | "Shift";

interface LocatorCheckOptions extends LocatorOptions {
  force?: boolean;
}

function timeoutOf(options: LocatorOptions = {}): number {
  const timeout = options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("Playwright timeout must be a positive integer");
  }
  return timeout;
}

export type TextMatcher = string | RegExp;

function isRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp || Object.prototype.toString.call(value) === "[object RegExp]";
}

function regexSelector(value: RegExp): string {
  const text = String(value);
  const flags = value.flags;
  const escaped = flags.includes("u") || flags.includes("v")
    ? text
    : text.replace(/(^|[^\\])(\\\\)*(["'`])/gu, "$1$2\\$3");
  return escaped.replace(/>>/gu, "\\>\\>");
}

function textMatcherSelector(value: TextMatcher, exact: boolean): string {
  if (isRegExp(value)) return regexSelector(value);
  if (typeof value !== "string") {
    throw new Error("Text locator requires a string or RegExp");
  }
  return `${JSON.stringify(value)}${exact ? "s" : "i"}`;
}

function attributeMatcherSelector(value: TextMatcher, exact: boolean): string {
  if (isRegExp(value)) return regexSelector(value);
  if (typeof value !== "string") {
    throw new Error("Attribute locator requires a string or RegExp");
  }
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"${exact ? "s" : "i"}`;
}

function requireSelector(value: string, method: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${method} requires a selector`);
  }
  return value;
}

function pointerModifiers(value: KeyboardModifier[] | undefined): number {
  if (value === undefined) return 0;
  const allowed = new Set<KeyboardModifier>([
    "Alt",
    "Control",
    "ControlOrMeta",
    "Meta",
    "Shift",
  ]);
  if (!Array.isArray(value) || value.some((modifier) => !allowed.has(modifier))) {
    throw new Error("locator click modifiers contain an unsupported keyboard modifier");
  }
  return value.reduce((mask, modifier) => {
    switch (modifier) {
      case "Alt": return mask | 1;
      case "Control": return mask | 2;
      case "ControlOrMeta":
      case "Meta": return mask | 4;
      case "Shift": return mask | 8;
    }
  }, 0);
}

function supportedLoadState(
  state: "load" | "domcontentloaded" | "networkidle" | undefined,
): "load" | "domcontentloaded" {
  if (state === "networkidle") {
    throw new Error("waitUntil: networkidle is not supported");
  }
  if (state !== undefined && state !== "load" && state !== "domcontentloaded") {
    throw new Error(`Unsupported load state: ${String(state)}`);
  }
  return state ?? "load";
}

type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

function supportedWaitUntil(value: WaitUntil | undefined): WaitUntil | undefined {
  if (
    value !== undefined
    && value !== "load"
    && value !== "domcontentloaded"
    && value !== "networkidle"
    && value !== "commit"
  ) {
    throw new Error(`Unsupported waitUntil state: ${String(value)}`);
  }
  return value;
}

function globUrlPattern(value: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === "*") {
      const isGlobstar = value[index + 1] === "*";
      pattern += isGlobstar ? ".*" : "[^/]*";
      index += isGlobstar ? 2 : 1;
      continue;
    }
    pattern += /[\\.^$|()[\]{}+?]/u.test(character)
      ? `\\${character}`
      : character;
    index += 1;
  }
  return new RegExp(`${pattern}$`, "u");
}

function validatePointOptions(
  options: { x: number; y: number; includeNonInteractable?: boolean },
  method: string,
): void {
  if (
    options == null
    || !Number.isFinite(options.x)
    || !Number.isFinite(options.y)
  ) {
    throw new Error(`${method} requires finite x and y coordinates`);
  }
  if (
    options.includeNonInteractable !== undefined
    && typeof options.includeNonInteractable !== "boolean"
  ) {
    throw new Error(`${method} includeNonInteractable must be a boolean`);
  }
}

function serializeEvaluationArg(arg: unknown): string {
  if (arg === undefined) return "undefined";
  try {
    const value = JSON.stringify(arg);
    if (value !== undefined) return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nplaywright.evaluate arg must be JSON-serializable`);
  }
  throw new Error("playwright.evaluate arg must be JSON-serializable");
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `notFound` and `notReady` are retryable; a strict-mode violation is not, since
 *  retrying cannot change the outcome. */
interface ResolveResult {
  found: boolean;
  /** Main-frame viewport coordinates, already converted through the frameChain and
   *  ready for Input.dispatchMouseEvent. */
  point?: { x: number; y: number };
  visible?: boolean;
}

interface OopifHop {
  geometry: { x: number; y: number; scaleX: number; scaleY: number };
  marker: string;
  targetId?: string;
}

interface FrameExecutionScope {
  executionContextId?: number;
  targetId?: string;
}

/**
 * Deterministic failures: retrying will never improve them, so they have to be
 * thrown immediately.
 *
 * Without this classification the retry loop swallows real errors and all the
 * caller ever sees is `Timed out after Nms waiting for selector ...`, with no way
 * to tell "the element never appeared" from "that iframe is cross-origin and
 * unreachable". That is not hypothetical: cross-origin cases once passed for the
 * wrong reason, on the selector name inside a timeout message.
 */
const FATAL_PATTERNS = [
  "strict mode violation",                 // The page genuinely has several matches.
  "Cross-origin or out-of-process",        // Cross-origin iframe; the in-page path cannot reach it.
  "must target a frame element",           // enter-frame pointed at something that is not a frame.
  "cannot be filled",                      // This input type does not support fill.
  "Read-only locator evaluation",          // Refused by policy; retrying changes nothing.
];
function isFatal(e: unknown): boolean {
  const m = String(e);
  return FATAL_PATTERNS.some((p) => m.includes(p));
}

/**
 * What `tab.playwright.locator(selector)` returns.
 *
 * A locator is not an element reference; it is a description of how to find one.
 * Every operation resolves it again, which is exactly why it survives a page
 * re-render where an element reference would go stale. Never cache an element or
 * objectId here.
 */
export class Locator {
  /**
   * `#` rather than `private`: `private` is compile-time only and leaves an
   * ordinary property that `getOwnPropertyNames` still enumerates, which a model
   * has actually done. `#` is private at runtime.
   */
  readonly #tab: Tab;
  readonly selector: string;
  /** The OOPIF chain the last resolution passed through; pointer coordinates are
   *  converted back through it to the top-level tab. */
  #lastOopifChain: OopifHop[] = [];

  constructor(tab: Tab, selector: string) {
    this.#tab = tab;
    this.selector = selector;
  }

  /**
   * Evaluate this selector in the page, re-parsing and re-querying on every call
   * (see the note above).
   *
   * `exceptionDetails` must be checked. An error thrown by the page inside
   * `Runtime.evaluate` does not reject the CDP call: it comes back quietly in
   * `exceptionDetails` while `result.value` is undefined. Skipping the check makes
   * every page-side exception look like "the element is not ready yet" and retry
   * until timeout, so the caller sees only `Timed out waiting for selector` while
   * the real cause, a cross-origin iframe or a strict violation or a syntax
   * error, is lost. That happened: cross-origin cases passed for the wrong
   * reason, and the FATAL_PATTERNS classification never took effect at all.
   */
  async #evaluateInternal<T>(body: string): Promise<T> {
    this.#lastOopifChain = [];
    return await this.#evaluateIn(body, {}, undefined, []);
  }

  /**
   * Cross-origin OOPIFs resolve in two stages.
   *
   * The first stage walks the selector in the main frame. On reaching a
   * cross-origin iframe the prelude tags it and reports back, since
   * `contentWindow` throws and the page cannot go further. The SDK then:
   *   1. `DOM.querySelector([marker])` then `DOM.describeNode`, whose frameId is
   *      the OOPIF's targetId;
   *   2. `attachTarget`, so the backend opens a flattened debugger session;
   *   3. injects Playwright separately into that target, since an injection does
   *      not cross processes;
   *   4. re-runs the operation there with the remaining selector.
   *
   * Each further OOPIF resolves its marker inside the current target, attaches
   * the child target, and pushes that level's coordinate transform onto the
   * chain, which is what makes OOPIFs nested inside OOPIFs work.
   */
  async #evaluateIn<T>(
    body: string,
    scope: FrameExecutionScope,
    selectorOverride?: unknown,
    chain: OopifHop[] = [],
  ): Promise<T> {
    if (scope.targetId == null && scope.executionContextId == null) {
      await injectPlaywright(this.#tab);
    } else {
      await injectPlaywrightInTarget(
        this.#tab,
        scope.targetId,
        scope.executionContextId,
      );
    }

    const expression =
      selectorOverride == null
        ? selectorExpression(this.selector, body)
        : parsedSelectorExpression(selectorOverride, body);

    const r = await cdp<{
      result?: {
        value?: T & {
          oopif?: {
            geometry: { x: number; y: number; scaleX: number; scaleY: number };
            marker: string;
            remaining: unknown;
          };
        };
      };
      exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string };
    }>(
      this.#tab,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(scope.executionContextId == null
          ? {}
          : { contextId: scope.executionContextId }),
      },
      scope.targetId,
    );
    const ex = r?.exceptionDetails;
    if (ex != null) {
      const message =
        ex.exception?.description ??
        (typeof ex.exception?.value === "string" ? ex.exception.value : undefined) ??
        ex.text ??
        "page evaluation failed";
      throw new Error(message);
    }
    const value = r?.result?.value;

    // Hit a cross-origin iframe: attach to it and re-run with the remaining
    // selector inside that target.
    const oopif = (
      value as {
        oopif?: {
          geometry: { x: number; y: number; scaleX: number; scaleY: number };
          marker: string;
          remaining: unknown;
        };
      } | undefined
    )?.oopif;
    if (oopif != null) {
      const frameId = await oopifTargetIdForMarker(
        this.#tab,
        oopif.marker,
        scope.targetId,
      );
      if (frameId == null) {
        throw new Error(`Cross-origin frame target not found for selector ${this.selector}`);
      }
      const childScope = await this.#resolveFrameExecutionScope(
        frameId,
        scope.targetId,
        chain,
      );
      const nextChain = [
        ...chain,
        {
          geometry: oopif.geometry,
          marker: oopif.marker,
          ...(childScope.targetId == null ? {} : { targetId: childScope.targetId }),
        },
      ];
      return await this.#evaluateIn<T>(body, childScope, oopif.remaining, nextChain);
    }
    this.#lastOopifChain = chain;
    return value as T;
  }

  async #resolveFrameExecutionScope(
    frameId: string,
    parentTargetId: string | undefined,
    chain: OopifHop[],
  ): Promise<FrameExecutionScope> {
    try {
      await attachTarget(this.#tab, frameId, parentTargetId);
      return { targetId: frameId };
    } catch (attachError) {
      const scopeErrors: string[] = [];
      const candidates = [
        parentTargetId,
        ...chain.map(({ targetId }) => targetId).reverse(),
        undefined,
      ].filter(
        (candidate, index, values) => values.indexOf(candidate) === index,
      );
      for (const targetId of candidates) {
        try {
          await cdp(this.#tab, "Page.enable", {}, targetId);
          const world = await cdp<{ executionContextId?: number }>(
            this.#tab,
            "Page.createIsolatedWorld",
            {
              frameId,
              grantUniveralAccess: false,
              worldName: "__operonBrowserUse",
            },
            targetId,
          );
          if (typeof world.executionContextId === "number") {
            return {
              executionContextId: world.executionContextId,
              ...(targetId == null ? {} : { targetId }),
            };
          }
        } catch (error) {
          scopeErrors.push(
            `${targetId ?? "top-level"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const attachMessage =
        attachError instanceof Error ? attachError.message : String(attachError);
      throw new Error(
        `Unable to resolve frame ${frameId}; attach failed: ${attachMessage}; isolated worlds failed: ${scopeErrors.join(" | ")}`,
      );
    }
  }


  /**
   * Retry until the deadline. This is what a locator is for: the element may not
   * have rendered, may still be animating, or may be covered for a moment.
   *
   * Deterministic failures (see FATAL_PATTERNS) are not retried; the original
   * error is thrown straight through.
   */
  async #retryUntil<T>(
    timeoutMs: number,
    attempt: () => Promise<T | undefined>,
  ): Promise<T> {
    const started = Date.now();
    let lastError: unknown;
    for (;;) {
      try {
        const out = await attempt();
        if (out !== undefined) return out;
      } catch (e) {
        if (isFatal(e)) throw e;   // Deterministic: let the real error out rather
                                   // than burying it under a timeout message.
        lastError = e;
      }
      if (Date.now() - started >= timeoutMs) {
        const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
        throw new Error(`Timed out after ${timeoutMs}ms waiting for selector ${this.selector}${detail}`);
      }
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }

  /** Number of matches. Zero is a valid answer, so this does not retry. */
  async count(): Promise<number> {
    await injectPlaywright(this.#tab);
    const r = await cdp<{ result?: { value?: number } }>(this.#tab, "Runtime.evaluate", {
      expression: wrapInjected(`(() => {
        const injected = window.${INJECTED};
        return injected.querySelectorAll(injected.parseSelector(${JSON.stringify(this.selector)}), document).length;
      })()`),
      returnByValue: true,
    });
    return r?.result?.value ?? 0;
  }

  /** Whether the element is currently visible. Not found means not visible, and
   *  does not throw, matching Playwright's semantics. */
  async isVisible(): Promise<boolean> {
    const v = await this.#evaluateInternal<boolean>(`
      if (!element) return false;
      return !!injected.elementState(element, "visible").matches;`);
    return v === true;
  }

  async textContent(options: LocatorOptions = {}): Promise<string | null> {
    return await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; text: string | null }>(`
        if (!element) return { found: false, text: null };
        return { found: true, text: element.textContent };`);
      return r?.found ? r.text : undefined;
    });
  }

  /**
   * Scroll into view, run full actionability, hit-test, and return a clickable
   * point.
   *
   * Actionability is not implemented here: `injected.checkElementStates(el, [...])`
   * is Playwright's own, covering visible, enabled and stable, where stable
   * compares bounding boxes across frames to confirm the animation has settled.
   * An earlier version only used `elementState(el, "visible")`, which threw that
   * away and treated animating and disabled buttons as clickable.
   *
   * Hit testing is the same story: `injected.expectHitTarget({x, y}, el)` confirms
   * that clicking that point really lands on the element rather than on a cookie
   * banner or modal covering it. It is the only defence against the whole class of
   * "the click did nothing" bugs.
   *
   * Failures from either are retryable signals, since an element may settle a
   * second later and an overlay may disappear, so they go back to the retry loop.
   */
  async #resolveBox(force = false): Promise<ResolveResult | undefined> {
    const r = await this.#evaluateInternal<{ found: boolean; missing?: string; hit?: string; point?: { x: number; y: number } }>(`
      if (!element) return { found: false };

      // Scroll into view, trying the three fallbacks in turn: some layouts do not
      // scroll correctly on the first.
      const fallbacks = ${JSON.stringify(SCROLL_FALLBACKS)};
      let box = element.getBoundingClientRect();
      for (const opts of fallbacks) {
        if (box.width > 0 && box.height > 0 &&
            box.top >= 0 && box.left >= 0 &&
            box.bottom <= window.innerHeight && box.right <= window.innerWidth) break;
        element.scrollIntoView(opts);
        box = element.getBoundingClientRect();
      }

      // Full actionability. The stable check confirms across frames that any
      // animation has stopped, so this has to be awaited.
      const states = await injected.checkElementStates(
        element,
        ${force ? '["stable"]' : '["visible", "enabled", "stable"]'},
      );
      if (states === "error:notconnected") return { found: true, missing: "notconnected" };
      if (states && states.missingState) return { found: true, missing: states.missingState };

      box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return { found: true, missing: "visible" };

      // Hit-test inside the element's own frame, where the coordinates are that
      // frame's viewport coordinates.
      const localPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      ${force ? "" : `
      const hit = injected.expectHitTarget(localPoint, element);
      if (hit !== "done") return { found: true, hit: String(hit) };
      `}

      // Input.dispatchMouseEvent only understands main-frame coordinates, so
      // convert back out through the frameChain. With no iframes the chain is
      // empty and the conversion is the identity.
      const point = scope.prepareFrameChainForPointerAction(localPoint, { block: "center", inline: "nearest" });
      return { found: true, point: { x: point.x, y: point.y } };`);

    // Not found, not in the right state, or covered: return undefined and let the
    // retry loop keep waiting, since all of those can resolve themselves.
    if (!r?.found || r.missing != null || r.hit != null || !r.point) return undefined;
    return { found: true, visible: true, point: r.point };
  }

  /** Resolve to main-frame coordinates, including actionability, hit testing and
   *  iframe or OOPIF conversion. */
  async #pointFor(timeout: number, force = false): Promise<{ x: number; y: number }> {
    const resolved = await this.#retryUntil(timeout, () => this.#resolveBox(force));
    const { x, y } = resolved.point!;

    /**
     * Coordinate compensation for cross-origin OOPIFs.
     *
     * The point `resolveBox` returns is in the viewport coordinates of the frame
     * the element lives in. Same-origin iframes have already been converted back
     * to the main frame by the prelude's `prepareFrameChainForPointerAction`, but
     * a cross-origin level cannot be: the page cannot reach the other window. So
     * the iframe element's position is measured from the main frame here and the
     * offset added back.
     *
     * `Input.dispatchMouseEvent` only understands main-frame coordinates, and
     * without this step a click inside an OOPIF lands on whatever main-frame
     * element sits near the iframe's top-left corner, silently and without error.
     */
    if (this.#lastOopifChain.length > 0) {
      return this.#lastOopifChain.reduceRight(
        (point, hop) => ({
          x: hop.geometry.x + point.x * hop.geometry.scaleX,
          y: hop.geometry.y + point.y * hop.geometry.scaleY,
        }),
        { x, y },
      );
    }
    return { x, y };
  }

  /**
   * Click.
   *
   * This dispatches real input events through `Input.dispatchMouseEvent` rather
   * than the synthetic `element.click()`, which plenty of sites can detect. The
   * sequence is mouseMoved, mousePressed, mouseReleased.
   */
  async click(options: ClickOptions = {}): Promise<void> {
    if (
      options.button !== undefined
      && options.button !== "left"
      && options.button !== "right"
      && options.button !== "middle"
    ) {
      throw new Error("locator click received an unsupported mouse button");
    }
    if (options.force !== undefined && typeof options.force !== "boolean") {
      throw new Error("locator click force must be a boolean");
    }
    if (
      options.clickCount !== undefined
      && (!Number.isInteger(options.clickCount) || options.clickCount <= 0)
    ) {
      throw new Error("locator clickCount must be a positive integer");
    }
    const modifiers = pointerModifiers(options.modifiers);
    const { x, y } = await this.#pointFor(timeoutOf(options), options.force === true);
    const button = buttonName(options.button);
    const clickCount = options.clickCount ?? 1;

    await cdp(this.#tab, "Input.dispatchMouseEvent", {
      type: "mouseMoved", button: "none", buttons: 0, modifiers, x, y,
    });
    await cdp(this.#tab, "Input.dispatchMouseEvent", {
      type: "mousePressed", button, buttons: buttonMask(button), clickCount, modifiers, x, y,
    });
    await cdp(this.#tab, "Input.dispatchMouseEvent", {
      type: "mouseReleased", button, buttons: 0, clickCount, modifiers, x, y,
    });
  }

  /** Hover: dispatches only mouseMoved, which is what opens menus and tooltips. */
  async hover(options: LocatorOptions = {}): Promise<void> {
    const { x, y } = await this.#pointFor(timeoutOf(options));
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, modifiers: 0, x, y });
  }

  /** Double click via clickCount: 2, not two separate clicks. Many controls only
   *  look at clickCount. */
  async dblclick(options: ClickOptions = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  /**
   * Check or uncheck.
   *
   * The current state is read before deciding whether to click, since clicking
   * unconditionally would uncheck something already checked. Matching
   * Playwright's semantics, an element already in the target state is a no-op.
   */
  async setChecked(want: boolean, options: LocatorCheckOptions = {}): Promise<void> {
    if (typeof want !== "boolean") {
      throw new Error("locator.setChecked requires a boolean");
    }
    const timeout = timeoutOf(options);
    const already = await this.#evaluateInternal<{
      found: boolean;
      checked?: boolean;
      isRadio?: boolean;
    }>(`
      if (!element) return { found: false };
      const checked = injected.elementState(element, "checked");
      return {
        found: true,
        checked: !!checked.matches,
        isRadio: !!checked.isRadio,
      };`);
    if (already?.found && already.checked === want) return;
    if (already?.isRadio === true && !want) {
      throw new Error("Cannot uncheck a radio button");
    }
    await this.click({ force: options.force, timeoutMs: timeout });
    // Confirm the state actually changed: some controls intercept the click.
    const after = await this.#retryUntil(timeout, async () => {
      const r = await this.#evaluateInternal<{ found: boolean; checked?: boolean }>(`
        if (!element) return { found: false };
        return { found: true, checked: !!injected.elementState(element, "checked").matches };`);
      return r?.found && r.checked === want ? true : undefined;
    });
    if (!after) throw new Error(`Failed to ${want ? "check" : "uncheck"} ${this.selector}`);
  }
  check(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(true, options);
  }
  uncheck(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(false, options);
  }

  /** Press a key via `Input.dispatchKeyEvent`. Focus first, or it lands on body. */
  async press(key: string, options: LocatorOptions = {}): Promise<void> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("locator.press requires a value");
    }
    await this.#focusWithStates(options, ["visible", "enabled"]);
    const k = KEY_MAP[key] ?? { key, code: key, vk: 0 };
    await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    if (k.text != null) await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "char", text: k.text });
    await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
  }

  async #focusWithStates(
    options: LocatorOptions,
    states: Array<"visible" | "enabled" | "editable">,
  ): Promise<void> {
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; missing?: string }>(`
        if (!element) return { found: false };
        const states = await injected.checkElementStates(
          element,
          ${JSON.stringify(states)},
        );
        if (states === "error:notconnected") {
          return { found: true, missing: "notconnected" };
        }
        if (states && states.missingState) {
          return { found: true, missing: states.missingState };
        }
        (injected.retarget(element, "follow-label") || element).focus();
        return { found: true };`);
      return r?.found && r.missing == null ? true : undefined;
    });
  }

  async focus(options: LocatorOptions = {}): Promise<void> {
    await this.#focusWithStates(options, []);
  }

  /** Select an option through injectedScript's selectOptions, which dispatches
   *  input and change. */
  async selectOption(
    values:
      | string
      | { value?: string; label?: string; index?: number }
      | Array<string | { value?: string; label?: string; index?: number }>,
    options: LocatorOptions = {},
  ): Promise<void> {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0) throw new Error("locator.selectOption requires at least one value");
    const descriptors = list.map((value) => {
      if (typeof value === "string") return { value };
      if (typeof value !== "object" || value == null) {
        throw new Error("locator.selectOption requires a string or { value?, label?, index? }");
      }
      const descriptor: { value?: string; label?: string; index?: number } = {};
      if (value.value !== undefined) {
        if (typeof value.value !== "string") {
          throw new Error("locator.selectOption value must be a string");
        }
        descriptor.value = value.value;
      }
      if (value.label !== undefined) {
        if (typeof value.label !== "string") {
          throw new Error("locator.selectOption label must be a string");
        }
        descriptor.label = value.label;
      }
      if (value.index !== undefined) {
        if (!Number.isInteger(value.index) || value.index < 0) {
          throw new Error("locator.selectOption index must be a non-negative integer");
        }
        descriptor.index = value.index;
      }
      if (
        descriptor.value === undefined
        && descriptor.label === undefined
        && descriptor.index === undefined
      ) {
        throw new Error("locator.selectOption requires value, label, or index for each selection");
      }
      return descriptor;
    });
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; status?: unknown }>(`
        if (!element) return { found: false };
        const states = await injected.checkElementStates(element, ["visible", "enabled"]);
        if (states === "error:notconnected" || (states && states.missingState)) {
          return {
            found: true,
            status: states === "error:notconnected"
              ? states
              : "error:" + states.missingState,
          };
        }
        const status = injected.selectOptions(element, ${JSON.stringify(descriptors)});
        return { found: true, status: status };`);
      if (!r?.found) return undefined;
      if (typeof r.status === "string" && r.status.startsWith("error:")) {
        return undefined;
      }
      return true;
    });
    recordTabMutation(this.#tab);
  }

  async getAttribute(name: string, options: LocatorOptions = {}): Promise<string | null> {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("locator.getAttribute requires a name");
    }
    return await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; v: string | null }>(`
        if (!element) return { found: false, v: null };
        return { found: true, v: element.getAttribute(${JSON.stringify(name)}) };`);
      return r?.found ? r.v : undefined;
    });
  }

  /** `innerText` is the rendered, visible text; `textContent` would include text
   *  from hidden nodes. */
  async innerText(options: LocatorOptions = {}): Promise<string> {
    return await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; v: string }>(`
        if (!element) return { found: false, v: "" };
        return { found: true, v: element.innerText };`);
      return r?.found ? r.v : undefined;
    });
  }

  /** Current value of a form control; `textContent` cannot read an input's value. */
  async inputValue(options: LocatorOptions = {}): Promise<string> {
    return await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; v: string }>(`
        if (!element) return { found: false, v: "" };
        const el = injected.retarget(element, "follow-label") || element;
        return { found: true, v: el.value == null ? "" : String(el.value) };`);
      return r?.found ? r.v : undefined;
    });
  }

  async #state(name: "enabled" | "checked" | "editable"): Promise<boolean> {
    const v = await this.#evaluateInternal<boolean>(`
      if (!element) return false;
      return !!injected.elementState(element, ${JSON.stringify(name)}).matches;`);
    return v === true;
  }
  isEnabled(): Promise<boolean> {
    return this.#state("enabled");
  }
  isChecked(): Promise<boolean> {
    return this.#state("checked");
  }
  isEditable(): Promise<boolean> {
    return this.#state("editable");
  }

  /** Bounding box in main-frame viewport coordinates, with iframe and OOPIF
   *  conversion applied. */
  async boundingBox(options: LocatorOptions = {}): Promise<Box | null> {
    const { x, y } = await this.#pointFor(timeoutOf(options));
    const size = await this.#evaluateInternal<{ found: boolean; w: number; h: number }>(`
      if (!element) return { found: false, w: 0, h: 0 };
      const b = element.getBoundingClientRect();
      return { found: true, w: b.width, h: b.height };`);
    if (!size?.found) return null;
    // `point` is the centre; derive the top-left from it.
    return { x: x - size.w / 2, y: y - size.h / 2, width: size.w, height: size.h };
  }

  /** Wait until the element reaches a state, visible by default. `detached` and
   *  `hidden` are for waiting on something to go away. */
  async waitFor(options: {
    state: "visible" | "hidden" | "attached" | "detached";
    timeout?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const want = options?.state;
    if (
      want !== "visible"
      && want !== "hidden"
      && want !== "attached"
      && want !== "detached"
    ) {
      throw new Error("locator.waitFor requires a state");
    }
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; visible?: boolean }>(`
        if (!element) return { found: false };
        return { found: true, visible: !!injected.elementState(element, "visible").matches };`);
      const found = r?.found === true;
      const ok =
        want === "attached" ? found
        : want === "detached" ? !found
        : want === "visible" ? found && r?.visible === true
        : /* hidden */ !found || r?.visible !== true;
      return ok ? true : undefined;
    });
  }

  /** The nth match, zero-based. `internal:nth` is documented Playwright syntax. */
  nth(index: number): Locator {
    if (typeof index !== "number") throw new Error("locator.nth requires a numeric index");
    return new Locator(this.#tab, `${this.selector} >> nth=${index}`);
  }
  first(): Locator {
    return this.nth(0);
  }
  last(): Locator {
    return new Locator(this.#tab, `${this.selector} >> nth=-1`);
  }

  /** One Locator per match, addressed by `nth`, so later operations still resolve
   *  afresh. */
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  /** Filter within the current matches; `internal:has-text` and friends are
   *  documented Playwright syntax. */
  filter(options: {
    hasText?: TextMatcher;
    hasNotText?: TextMatcher;
    has?: Locator;
    hasNot?: Locator;
    visible?: boolean;
  } = {}): Locator {
    let sel = this.selector;
    if (options.hasText != null) {
      sel += ` >> internal:has-text=${textMatcherSelector(options.hasText, false)}`;
    }
    if (options.hasNotText != null) {
      sel += ` >> internal:has-not-text=${textMatcherSelector(options.hasNotText, false)}`;
    }
    if (options.has != null) {
      this.#assertCompatibleLocator(options.has, "locator.filter has");
      sel += ` >> internal:has=${JSON.stringify(options.has.selector)}`;
    }
    if (options.hasNot != null) {
      this.#assertCompatibleLocator(options.hasNot, "locator.filter hasNot");
      sel += ` >> internal:has-not=${JSON.stringify(options.hasNot.selector)}`;
    }
    if (options.visible != null) {
      if (typeof options.visible !== "boolean") {
        throw new Error("locator.filter visible must be a boolean");
      }
      sel += ` >> visible=${String(options.visible)}`;
    }
    return new Locator(this.#tab, sel);
  }
  and(other: Locator): Locator {
    this.#assertCompatibleLocator(other, "locator.and");
    return new Locator(this.#tab, `${this.selector} >> internal:and=${JSON.stringify(other.selector)}`);
  }
  or(other: Locator): Locator {
    this.#assertCompatibleLocator(other, "locator.or");
    return new Locator(this.#tab, `${this.selector} >> internal:or=${JSON.stringify(other.selector)}`);
  }

  locator(selector: string, options: {
    hasText?: TextMatcher;
    hasNotText?: TextMatcher;
    has?: Locator;
    hasNot?: Locator;
  } = {}): Locator {
    return new Locator(
      this.#tab,
      `${this.selector} >> ${requireSelector(selector, "locator.locator")}`,
    ).filter(options);
  }

  getByRole(role: string, options: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return this.locator(roleSelector(role, options));
  }

  getByText(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:text=${textMatcherSelector(text, options.exact === true)}`);
  }

  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:label=${textMatcherSelector(text, options.exact === true)}`);
  }

  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(
      `internal:attr=[placeholder=${attributeMatcherSelector(text, options.exact === true)}]`,
    );
  }

  getByTestId(testId: string): Locator {
    if (typeof testId !== "string" || testId.length === 0) {
      throw new Error("getByTestId requires a testId");
    }
    return this.locator(
      `internal:testid=[data-testid=${attributeMatcherSelector(testId, true)}]`,
    );
  }

  #assertCompatibleLocator(other: Locator, method: string): void {
    if (!(other instanceof Locator)) {
      throw new Error(`${method} requires a PlaywrightLocator`);
    }
    if (other.#tab !== this.#tab) throw new Error("Locators must belong to the same tab");
  }

  /** Evaluate against the element. `fn` is a function body as a string, since a
   *  closure cannot cross processes. */
  async evaluate<TResult = unknown, TArg = unknown>(
    pageFunction: string | ((element: unknown, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options: LocatorOptions = {},
  ): Promise<TResult> {
    if (
      (typeof pageFunction !== "string" && typeof pageFunction !== "function")
      || (typeof pageFunction === "string" && pageFunction.length === 0)
    ) {
      throw new Error("locator.evaluate requires a pageFunction");
    }
    const fnBody = typeof pageFunction === "function" ? pageFunction.toString() : pageFunction;
    const serializedArg = serializeEvaluationArg(arg);
    return await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; v: TResult }>(`
        if (!element) return { found: false };
        ${readOnlyGuardSource("Read-only locator evaluation cannot mutate the page")}
        try {
          return { found: true, v: await (${fnBody})(element, ${serializedArg}) };
        } finally {
          for (let i = restores.length - 1; i >= 0; i--) {
            try { restores[i](); } catch {}
          }
        }`);
      return r?.found ? ({ v: r.v } as { v: TResult }) : undefined;
    }).then((x) => x.v);
  }

  /** Clear the field: sugar for `fill("")`, which takes the Delete path. */
  clear(options: LocatorOptions = {}): Promise<void> {
    return this.fill("", options);
  }

  /** Type character by character. Unlike `fill`, this fires every keydown and
   *  keypress, which some autocomplete implementations depend on. */
  async type(text: string, options: LocatorOptions = {}): Promise<void> {
    if (typeof text !== "string") throw new Error("locator.type requires a value");
    await this.#focusWithStates(options, ["visible", "enabled", "editable"]);
    for (const ch of text) {
      await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  }

  async downloadMedia(options: LocatorOptions = {}): Promise<void> {
    const pageUrl = await this.#tab.url() ?? "";
    await ensureFileTransferAllowed(pageUrl, "download");
    const waiting = this.#tab.playwright.waitForEvent("download", { timeoutMs: timeoutOf(options) });
    await this.click(options);
    const download = await waiting;
    await download.path({ timeoutMs: timeoutOf(options) });
  }

  /** Select the text inside an element, through injectedScript, which knows the
   *  difference between contenteditable and an input. */
  async selectText(options: LocatorOptions = {}): Promise<void> {
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; status?: unknown }>(`
        if (!element) return { found: false };
        return { found: true, status: injected.selectText(element) };`);
      return r?.found && r.status !== "error:notconnected" ? true : undefined;
    });
    recordTabMutation(this.#tab);
  }

  async scrollIntoViewIfNeeded(options: LocatorOptions = {}): Promise<void> {
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean }>(`
        if (!element) return { found: false };
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return { found: true };`);
      return r?.found ? true : undefined;
    });
  }

  async blur(options: LocatorOptions = {}): Promise<void> {
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean }>(`
        if (!element) return { found: false };
        element.blur();
        return { found: true };`);
      return r?.found ? true : undefined;
    });
  }

  /** Drag onto another locator; both ends resolve to main-frame coordinates. */
  async dragTo(target: Locator, options: LocatorOptions = {}): Promise<void> {
    const timeout = timeoutOf(options);
    const from = await this.#pointFor(timeout);
    const to = await target.#pointFor(timeout);
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: from.x, y: from.y });
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, x: from.x, y: from.y });
    // An intermediate point: without one, many HTML5 drag implementations do not
    // recognise this as a drag at all.
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: to.x, y: to.y });
    await cdp(this.#tab, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, x: to.x, y: to.y });
  }

  /** Upload files through injectedScript's setInputFiles, which dispatches change. */
  async setInputFiles(files: Array<{ name: string; mimeType: string; base64: string }>, options: LocatorOptions = {}): Promise<void> {
    await ensureFileTransferAllowed(await this.#tab.url() ?? "", "upload");
    await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; status?: unknown }>(`
        if (!element) return { found: false };
        const status = await injected.setInputFiles(element, ${JSON.stringify(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.base64 })))});
        return { found: true, status: status };`);
      return r?.found && r.status !== "error:notconnected" ? true : undefined;
    });
    recordTabMutation(this.#tab);
  }

  /** Text of every match. Note this uses `querySelectorAll` and so is not strict. */
  async allTextContents(_options: LocatorOptions = {}): Promise<string[]> {
    await injectPlaywright(this.#tab);
    const r = await cdp<{ result?: { value?: string[] } }>(this.#tab, "Runtime.evaluate", {
      expression: wrapInjected(`(() => {
        const injected = window.${INJECTED};
        return injected.querySelectorAll(injected.parseSelector(${JSON.stringify(this.selector)}), document)
          .map((e) => e.textContent == null ? "" : e.textContent);
      })()`),
      returnByValue: true,
    });
    return r?.result?.value ?? [];
  }

  /**
   * Fill a form field.
   *
   * `injected.fill()` does not necessarily fill anything: it is a three-state
   * protocol.
   *
   * | returns | meaning | what the driver must do |
   * |---|---|---|
   * | `"done"` | the value was set directly (color, date, range and similar) | nothing |
   * | `"needsinput"` | it only focused and selected, and waits for the driver to type (text, email, password, contenteditable) | send `Input.insertText` |
   * | `"error:notconnected"` | the element went away | retry |
   *
   * An earlier version treated only "done" as success, so every text field hung
   * until timeout. Only a real browser exposed that; a fake driver cannot.
   *
   * The reason for following this protocol rather than assigning `value` directly
   * is that a direct assignment dispatches no input event, and React never sees it.
   */
  async fill(value: string, options: LocatorOptions = {}): Promise<void> {
    if (typeof value !== "string") {
      throw new Error("locator.fill requires a value");
    }
    const needsInput = await this.#retryUntil(timeoutOf(options), async () => {
      const r = await this.#evaluateInternal<{ found: boolean; status?: string }>(`
        if (!element) return { found: false };
        const states = await injected.checkElementStates(
          element,
          ["visible", "enabled", "editable"],
        );
        if (states === "error:notconnected") {
          return { found: true, status: "error:notconnected" };
        }
        if (states && states.missingState) {
          return { found: true, status: "error:" + states.missingState };
        }
        const status = injected.fill(element, ${JSON.stringify(value)});
        return { found: true, status: status };`);
      if (!r?.found) return undefined;
      if (r.status === "done") return false;
      if (r.status === "needsinput") return true;
      return undefined; // error:notconnected and similar: retry.
    });
    if (!needsInput) {
      recordTabMutation(this.#tab);
      return;
    }

    // injectedScript has already focused and selected everything; type the value in.
    if (value === "") {
      // insertText is a no-op for an empty value, so press Delete to clear the
      // selection instead, the same way Playwright does.
      await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await cdp(this.#tab, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      recordTabMutation(this.#tab);
      return;
    }
    await cdp(this.#tab, "Input.insertText", { text: value });
    recordTabMutation(this.#tab);
  }
}

/**
 * `frameLocator(sel)` anchors every subsequent locator inside a frame.
 *
 * It is pure selector composition: `frameLocator("#pay").getByRole("button")` is
 * `#pay >> internal:control=enter-frame >> internal:role=button`. Whether the
 * frame is same-origin, cross-origin or nested is handled below by
 * `selectorScopeFor` and the OOPIF path, and this layer never needs to know.
 */
export class FrameLocator {
  readonly #tab: Tab;
  readonly #prefix: string;

  constructor(tab: Tab, prefix: string) {
    this.#tab = tab;
    this.#prefix = prefix;
  }

  #scoped(selector: string): Locator {
    return new Locator(this.#tab, `${this.#prefix} >> ${selector}`);
  }

  frameLocator(frameSelector: string): FrameLocator {
    return new FrameLocator(
      this.#tab,
      `${this.#prefix} >> ${requireSelector(frameSelector, "frameLocator.frameLocator")} >> internal:control=enter-frame`,
    );
  }
  locator(selector: string): Locator {
    return this.#scoped(requireSelector(selector, "frameLocator.locator"));
  }
  getByRole(role: string, options: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return this.#scoped(roleSelector(role, options));
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.#scoped(`internal:text=${textMatcherSelector(text, options.exact === true)}`);
  }
  getByLabel(label: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.#scoped(`internal:label=${textMatcherSelector(label, options.exact === true)}`);
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.#scoped(
      `internal:attr=[placeholder=${attributeMatcherSelector(text, options.exact === true)}]`,
    );
  }
  getByTestId(testId: string): Locator {
    if (typeof testId !== "string" || testId.length === 0) {
      throw new Error("getByTestId requires a testId");
    }
    return this.#scoped(
      `internal:testid=[data-testid=${attributeMatcherSelector(testId, true)}]`,
    );
  }
}

/** Builds the selector for getByRole; shared by FrameLocator and PlaywrightApi. */
function roleSelector(
  role: string,
  options: { name?: TextMatcher; exact?: boolean },
): string {
  if (typeof role !== "string" || role.length === 0) {
    throw new Error("getByRole requires a role");
  }
  const name = options.name == null
    ? ""
    : `[name=${attributeMatcherSelector(options.name, options.exact === true)}]`;
  return `internal:role=${role}${name}`;
}

function readOnlyGuardSource(message: string): string {
  const errorMessage = JSON.stringify(message);
  return `
    const restores = [];
    const nativeDefineProperty = Object.defineProperty;
    const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const findDescriptor = (target, name) => {
      for (let owner = target; owner; owner = Object.getPrototypeOf(owner)) {
        const descriptor = nativeGetOwnPropertyDescriptor(owner, name);
        if (descriptor) return { owner, descriptor };
      }
      return undefined;
    };
    const replaceMethod = (target, name, replacement) => {
      if (!target) return;
      const found = findDescriptor(target, name);
      if (!found || typeof found.descriptor.value !== "function" ||
          found.descriptor.configurable === false) return;
      nativeDefineProperty(found.owner, name, { ...found.descriptor, value: replacement });
      restores.push(() => nativeDefineProperty(found.owner, name, found.descriptor));
    };
    const blockMethod = (target, name) => {
      replaceMethod(target, name, function() { throw new Error(${errorMessage}); });
    };
    const blockSetter = (target, name) => {
      if (!target) return;
      const found = findDescriptor(target, name);
      if (!found || typeof found.descriptor.set !== "function" ||
          found.descriptor.configurable === false) return;
      nativeDefineProperty(found.owner, name, {
        ...found.descriptor,
        set() { throw new Error(${errorMessage}); }
      });
      restores.push(() => nativeDefineProperty(found.owner, name, found.descriptor));
    };
    const mutationMethods = [
      [Node.prototype, "appendChild"], [Node.prototype, "insertBefore"],
      [Node.prototype, "removeChild"], [Node.prototype, "replaceChild"],
      [Node.prototype, "normalize"], [Element.prototype, "append"],
      [Element.prototype, "prepend"], [Element.prototype, "before"],
      [Element.prototype, "after"], [Element.prototype, "replaceChildren"],
      [Element.prototype, "replaceWith"], [Element.prototype, "remove"],
      [Element.prototype, "setAttribute"], [Element.prototype, "setAttributeNS"],
      [Element.prototype, "removeAttribute"], [Element.prototype, "removeAttributeNS"],
      [Element.prototype, "toggleAttribute"], [Element.prototype, "insertAdjacentElement"],
      [Element.prototype, "insertAdjacentHTML"], [Element.prototype, "insertAdjacentText"],
      [HTMLElement.prototype, "click"], [HTMLFormElement.prototype, "submit"],
      [HTMLFormElement.prototype, "requestSubmit"], [HTMLFormElement.prototype, "reset"],
      [Storage.prototype, "setItem"], [Storage.prototype, "removeItem"],
      [Storage.prototype, "clear"], [History.prototype, "back"],
      [History.prototype, "forward"], [History.prototype, "go"],
      [History.prototype, "pushState"], [History.prototype, "replaceState"],
      [Document.prototype, "write"], [Document.prototype, "writeln"],
      [Document.prototype, "execCommand"], [CSSStyleDeclaration.prototype, "setProperty"],
      [CSSStyleDeclaration.prototype, "removeProperty"], [DOMTokenList.prototype, "add"],
      [DOMTokenList.prototype, "remove"], [DOMTokenList.prototype, "replace"],
      [DOMTokenList.prototype, "toggle"], [Range.prototype, "deleteContents"],
      [Range.prototype, "extractContents"], [Range.prototype, "insertNode"],
      [Range.prototype, "surroundContents"], [Selection.prototype, "deleteFromDocument"],
      [EventTarget.prototype, "dispatchEvent"]
    ];
    for (const [owner, name] of mutationMethods) blockMethod(owner, name);
    const mutationSetters = [
      [Node.prototype, "nodeValue"], [Node.prototype, "textContent"],
      [Element.prototype, "className"], [Element.prototype, "id"],
      [Element.prototype, "innerHTML"], [Element.prototype, "outerHTML"],
      [Element.prototype, "slot"], [HTMLElement.prototype, "innerText"],
      [HTMLElement.prototype, "hidden"], [HTMLInputElement.prototype, "value"],
      [HTMLInputElement.prototype, "checked"], [HTMLTextAreaElement.prototype, "value"],
      [HTMLSelectElement.prototype, "value"], [HTMLSelectElement.prototype, "selectedIndex"],
      [HTMLOptionElement.prototype, "selected"], [Document.prototype, "cookie"],
      [Location.prototype, "href"], [CSSStyleDeclaration.prototype, "cssText"]
    ];
    for (const [owner, name] of mutationSetters) blockSetter(owner, name);
    for (const name of Object.getOwnPropertyNames(CSSStyleDeclaration.prototype)) {
      blockSetter(CSSStyleDeclaration.prototype, name);
    }
    blockMethod(globalThis, "open");
    blockMethod(globalThis, "WebSocket");
    blockMethod(globalThis, "EventSource");
    blockMethod(globalThis, "Worker");
    blockMethod(globalThis, "SharedWorker");
    blockMethod(navigator, "sendBeacon");
    blockMethod(navigator.clipboard, "write");
    blockMethod(navigator.clipboard, "writeText");
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === "function") {
      replaceMethod(globalThis, "fetch", function(input, init) {
        const method = String(init?.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          throw new Error("Read-only browser evaluation only allows GET and HEAD requests");
        }
        return originalFetch.call(this, input, init);
      });
    }
    const originalXhrOpen = globalThis.XMLHttpRequest?.prototype?.open;
    if (typeof originalXhrOpen === "function") {
      replaceMethod(XMLHttpRequest.prototype, "open", function(method, ...args) {
        const normalized = String(method).toUpperCase();
        if (normalized !== "GET" && normalized !== "HEAD") {
          throw new Error("Read-only browser evaluation only allows GET and HEAD requests");
        }
        return originalXhrOpen.call(this, method, ...args);
      });
    }
    replaceMethod(Object, "defineProperty", function() { throw new Error(${errorMessage}); });
    replaceMethod(Object, "defineProperties", function() { throw new Error(${errorMessage}); });
    replaceMethod(Object, "setPrototypeOf", function() { throw new Error(${errorMessage}); });
    replaceMethod(Reflect, "defineProperty", function() { throw new Error(${errorMessage}); });
    replaceMethod(Reflect, "setPrototypeOf", function() { throw new Error(${errorMessage}); });
  `;
}

function readOnlyEvaluationExpression(
  pageFunction: string | ((arg: unknown) => unknown),
  arg: unknown,
): string {
  const serializedArg = serializeEvaluationArg(arg);
  const source = typeof pageFunction === "function" ? pageFunction.toString() : pageFunction.trim();
  const looksCallable =
    typeof pageFunction === "function" ||
    /^(?:async\s+)?function\b/u.test(source) ||
    /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(source);
  const looksLikeStatement =
    /^(?:throw\b|return\b|const\b|let\b|var\b|if\b|for\b|while\b|switch\b|try\b)/u.test(source);
  const invocation =
    looksCallable
      ? `(${source})(${serializedArg})`
      : looksLikeStatement
        ? `(async () => { ${source} })()`
        : `(${source})`;
  return `(async () => {
    ${readOnlyGuardSource("Read-only browser evaluation cannot mutate the page")}
    try {
      return await ${invocation};
    } finally {
      for (let i = restores.length - 1; i >= 0; i--) {
        try { restores[i](); } catch {}
      }
    }
  })()`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface AriaSnapshotResult {
  full: string;
  iframeDepths: Record<string, number>;
  iframeRefs: string[];
}

interface SnapshotTreeNode {
  children: SnapshotTreeNode[];
  indent: number;
  line: string;
}

const ENTER_FRAME_SELECTOR = " >> internal:control=enter-frame >> ";
const DOM_SNAPSHOT_FRAME_TIMEOUT_MS = 500;
const DOM_SNAPSHOT_TOTAL_TIMEOUT_MS = 1_000;

function snapshotExpression(elementExpression: string): string {
  return `(() => {
    const snapshotRoot = ${elementExpression};
    if (!snapshotRoot) return { full: "", iframeDepths: {}, iframeRefs: [] };
    const injected = window.${INJECTED};
    const snapshot = injected.incrementalAriaSnapshot(snapshotRoot, { mode: "ai" });
    const iframeDepths = snapshot.iframeDepths
      || Object.fromEntries(snapshot.iframeRefs.map((ref) => [ref, 0]));
    const iframeRefs = snapshot.iframeRefs.filter((ref) => {
      if (!(ref in iframeDepths)) return false;
      try {
        const [frame] = injected.querySelectorAll(
          injected.parseSelector("aria-ref=" + ref),
          snapshotRoot
        );
        return frame != null
          && frame.getAttribute("aria-hidden") !== "true"
          && injected.elementState(frame, "visible").matches === true;
      } catch {
        return false;
      }
    });
    let iframeIndex = 0;
    const full = snapshot.full.split("\\n").map((line) => {
      if (!line.trimStart().startsWith("- iframe") || line.includes("[ref=")) return line;
      const ref = snapshot.iframeRefs[iframeIndex++];
      return ref == null ? line : line + " [ref=" + ref + "]";
    }).join("\\n");
    return { ...snapshot, full, iframeDepths, iframeRefs };
  })()`;
}

function iframeRefFromSnapshotLine(line: string): string | undefined {
  if (!line.trimStart().startsWith("- iframe")) return undefined;
  return /\[ref=([^\]]+)\]/u.exec(line)?.[1];
}

async function snapshotForSelector(
  tab: Tab,
  selector: string,
  timeoutMs: number,
): Promise<AriaSnapshotResult> {
  return await new Locator(tab, selector).evaluate<AriaSnapshotResult>(
    `(element) => ${snapshotExpression("element")}`,
    undefined,
    { timeout: timeoutMs },
  );
}

async function expandSnapshotFrames(
  tab: Tab,
  snapshot: AriaSnapshotResult,
  deadlineMs: number,
  parentFrameSelector?: string,
): Promise<string> {
  const refs = snapshot.iframeRefs.filter((ref) => ref in snapshot.iframeDepths);
  if (refs.length === 0 || Date.now() >= deadlineMs) return snapshot.full;
  const expanded = new Map<string, string | undefined>(
    await Promise.all(refs.map(async (ref) => {
      const frameSelector =
        parentFrameSelector == null
          ? `aria-ref=${ref}`
          : `${parentFrameSelector}${ENTER_FRAME_SELECTOR}aria-ref=${ref}`;
      if (Date.now() >= deadlineMs) return [ref, undefined] as const;
      const timeoutMs = Math.max(
        1,
        Math.min(DOM_SNAPSHOT_FRAME_TIMEOUT_MS, deadlineMs - Date.now()),
      );
      try {
        const child = await snapshotForSelector(
          tab,
          `${frameSelector}${ENTER_FRAME_SELECTOR}body`,
          timeoutMs,
        );
        return [
          ref,
          await expandSnapshotFrames(tab, child, deadlineMs, frameSelector),
        ] as const;
      } catch {
        return [ref, undefined] as const;
      }
    })),
  );

  const lines: string[] = [];
  for (const line of snapshot.full.split("\n")) {
    const ref = iframeRefFromSnapshotLine(line);
    const child = ref == null ? undefined : expanded.get(ref);
    if (child == null) {
      lines.push(line);
      continue;
    }
    const indent = line.match(/^ */u)?.[0] ?? "";
    lines.push(line.endsWith(":") ? line : `${line}:`);
    lines.push(...child.split("\n").map((childLine) => `${indent}  ${childLine}`));
  }
  return lines.join("\n");
}

function parseSnapshotTree(snapshot: string): SnapshotTreeNode[] {
  const root: SnapshotTreeNode = { children: [], indent: -1, line: "" };
  const stack = [root];
  for (const rawLine of snapshot.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.match(/^ */u)?.[0].length ?? 0;
    const node: SnapshotTreeNode = {
      children: [],
      indent,
      line: rawLine.slice(indent),
    };
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
  return root.children;
}

function normalizeSnapshotLine(line: string): string {
  return line
    .replace(/ \[ref=[^\]]+\]/gu, "")
    .replace(/ \[cursor=[^\]]+\]/gu, "");
}

function normalizeSnapshotNodes(nodes: SnapshotTreeNode[]): SnapshotTreeNode[] {
  return nodes.flatMap((node) => {
    const children = normalizeSnapshotNodes(node.children);
    const line = normalizeSnapshotLine(node.line);
    if (/^- img(?: \[[^\]]+\])*:?$/u.test(line)) return [];
    if (/^- (?:generic|listitem|group)(?: \[[^\]]+\])*:?$/u.test(line)) return children;
    return [{ children, indent: node.indent, line }];
  });
}

function renderSnapshotTree(nodes: SnapshotTreeNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}${node.line}`);
    const children = renderSnapshotTree(node.children, depth + 1);
    if (children !== "") lines.push(children);
  }
  return lines.join("\n");
}

function compactDomSnapshot(snapshot: string): string {
  if (
    !snapshot.startsWith("- ")
    && !snapshot.includes("\n- ")
    && !snapshot.includes("\n  - ")
  ) {
    return snapshot;
  }
  return renderSnapshotTree(normalizeSnapshotNodes(parseSnapshotTree(snapshot)));
}

export class PlaywrightDownload {
  readonly #completion: Promise<string | null>;

  constructor(completion: Promise<string | null>) {
    this.#completion = completion;
  }

  path(options: { timeoutMs?: number } = {}): Promise<string | null> {
    return withTimeout(this.#completion, timeoutOf(options), "download");
  }
}

export class PlaywrightFileChooser {
  readonly #tab: Tab;
  readonly #backendNodeId: number;
  readonly #multiple: boolean;

  constructor(tab: Tab, backendNodeId: number, multiple: boolean) {
    this.#tab = tab;
    this.#backendNodeId = backendNodeId;
    this.#multiple = multiple;
  }

  isMultiple(): boolean {
    return this.#multiple;
  }

  async setFiles(files: string | string[], options: { timeoutMs?: number } = {}): Promise<void> {
    const paths = Array.isArray(files) ? files : [files];
    if (paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length === 0)) {
      throw new Error("fileChooser.setFiles requires at least one file path");
    }
    if (!this.#multiple && paths.length > 1) {
      throw new Error("This file chooser does not accept multiple files");
    }
    for (const path of paths) {
      if (!isAbsolute(path)) {
        throw new Error(`File chooser paths must be absolute: ${path}`);
      }
      const file = await stat(path).catch(() => undefined);
      if (file == null) throw new Error(`File does not exist: ${path}`);
      if (!file.isFile() && !file.isDirectory()) {
        throw new Error(`File chooser path must be a file or directory: ${path}`);
      }
    }
    await ensureFileTransferAllowed(await this.#tab.url() ?? "", "upload");
    await withTimeout(
      cdp(this.#tab, "DOM.setFileInputFiles", {
        files: paths,
        backendNodeId: this.#backendNodeId,
      }),
      timeoutOf(options),
      "file chooser",
    );
  }
}

/** `tab.playwright` */
export class PlaywrightApi {
  readonly #tab: Tab;

  constructor(tab: Tab) {
    this.#tab = tab;
  }

  locator(selector: string): Locator {
    return new Locator(this.#tab, requireSelector(selector, "locator"));
  }

  /** Sugar that compiles to a Playwright selector string, which injectedScript
   *  understands. */
  getByRole(role: string, options: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return this.locator(roleSelector(role, options));
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(
      `internal:attr=[placeholder=${attributeMatcherSelector(text, options.exact === true)}]`,
    );
  }
  getByAltText(text: string): Locator {
    return this.locator(`internal:attr=[alt=${JSON.stringify(text)}i]`);
  }
  getByTitle(text: string): Locator {
    return this.locator(`internal:attr=[title=${JSON.stringify(text)}i]`);
  }

  /** Anchor into a frame. Cross-origin and nested cases are handled below. */
  frameLocator(frameSelector: string): FrameLocator {
    return new FrameLocator(
      this.#tab,
      `${requireSelector(frameSelector, "frameLocator")} >> internal:control=enter-frame`,
    );
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:text=${textMatcherSelector(text, options.exact === true)}`);
  }
  getByLabel(label: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:label=${textMatcherSelector(label, options.exact === true)}`);
  }
  getByTestId(testId: string): Locator {
    if (typeof testId !== "string" || testId.length === 0) {
      throw new Error("getByTestId requires a testId");
    }
    return this.locator(
      `internal:testid=[data-testid=${attributeMatcherSelector(testId, true)}]`,
    );
  }

  /**
   * Evaluate in the page. `expression` is a string, since a closure cannot cross
   * processes.
   *
   * This carries more weight than it looks: the site adapters depend on it
   * entirely. `bilibili.hot`, for instance, navigates and then evaluates a
   * `fetch(..., {credentials:"include"})` to read structured data using the
   * user's own cookies. Without this method the whole adapter path dies with
   * `tab.playwright.evaluate is not a function`.
   *
   * Errors thrown by the page are re-thrown here; without checking
   * `exceptionDetails` they would silently become undefined.
   */
  async evaluate<TResult = unknown, TArg = unknown>(
    pageFunction: string | ((arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options: { timeoutMs?: number } = {},
  ): Promise<TResult> {
    if (
      (typeof pageFunction !== "string" && typeof pageFunction !== "function")
      || (typeof pageFunction === "string" && pageFunction.length === 0)
    ) {
      throw new Error("playwright.evaluate requires a pageFunction");
    }
    await injectPlaywright(this.#tab);
    const request = cdp<{
      result?: { value?: TResult };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(this.#tab, "Runtime.evaluate", {
      expression: readOnlyEvaluationExpression(pageFunction as string | ((arg: unknown) => unknown), arg),
      returnByValue: true,
      awaitPromise: true,
    });
    const r = await withTimeout(request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "page evaluation");
    const ex = r?.exceptionDetails;
    if (ex != null) throw new Error(ex.exception?.description ?? ex.text ?? "page evaluation failed");
    return r?.result?.value as TResult;
  }

  /** The agent's workhorse: a clickable tree with refs. An `aria-ref=eN` can be
   *  fed straight back into `locator()`. */
  async ariaSnapshot(): Promise<string> {
    await injectPlaywright(this.#tab);
    const r = await cdp<{ result?: { value?: string } }>(this.#tab, "Runtime.evaluate", {
      expression: wrapInjected(
        `window.${INJECTED}.ariaSnapshot(document.body, { mode: "ai", refPrefix: "" })`,
      ),
      returnByValue: true,
    });
    return r?.result?.value ?? "";
  }

  async domSnapshot(): Promise<string> {
    await injectPlaywright(this.#tab);
    const root = await cdp<{
      result?: { value?: AriaSnapshotResult };
      exceptionDetails?: {
        exception?: { description?: string; value?: unknown };
        text?: string;
      };
    }>(
      this.#tab,
      "Runtime.evaluate",
      {
        expression: wrapInjected(
          snapshotExpression("document.body || document.documentElement"),
        ),
        returnByValue: true,
      },
    );
    if (root?.exceptionDetails != null) {
      const details = root.exceptionDetails;
      throw new Error(
        details.exception?.description
        ?? (typeof details.exception?.value === "string" ? details.exception.value : undefined)
        ?? details.text
        ?? "DOM snapshot evaluation failed",
      );
    }
    const snapshot = root?.result?.value ?? {
      full: "",
      iframeDepths: {},
      iframeRefs: [],
    };
    const expanded = await expandSnapshotFrames(
      this.#tab,
      snapshot,
      Date.now() + DOM_SNAPSHOT_TOTAL_TIMEOUT_MS,
    );
    return compactDomSnapshot(expanded);
  }

  async elementInfo(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<Array<{
    ariaName?: string | null;
    boundingBox?: { x: number; y: number; width: number; height: number } | null;
    nodeId?: number | null;
    preview: string;
    role?: string | null;
    selector: {
      candidates: string[];
      frameSelectors?: string[];
      primary?: string | null;
    };
    tagName: string;
    testId?: string | null;
    visibleText?: string | null;
  }>> {
    validatePointOptions(options, "elementInfo");
    return await this.evaluate(`(arg) => {
      const interactable = (element) => {
        const tag = element.tagName.toLowerCase();
        return ["a", "button", "input", "select", "textarea", "summary"].includes(tag) ||
          element.hasAttribute("role") ||
          element.hasAttribute("onclick") ||
          element.hasAttribute("contenteditable") ||
          element.hasAttribute("tabindex");
      };
      return document.elementsFromPoint(arg.x, arg.y)
        .filter((element) => arg.includeNonInteractable || interactable(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const testId = element.getAttribute("data-testid");
          const id = element.id;
          const role = element.getAttribute("role");
          const tagName = element.tagName.toLowerCase();
          const rawText =
            tagName === "input" || tagName === "textarea" || tagName === "select"
              ? element.value
              : element.innerText || element.textContent || "";
          const text = String(rawText || "").trim().slice(0, 200);
          const ariaName = element.getAttribute("aria-label");
          const candidates = [];
          if (testId) {
            candidates.push(
              'internal:testid=[data-testid="' +
              testId.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"') +
              '"s]',
            );
          }
          if (id) candidates.push("#" + CSS.escape(id));
          if (role) {
            candidates.push(
              "internal:role=" + role +
              (ariaName ? '[name="' + ariaName.replaceAll('"', '\\\\"') + '"i]' : ""),
            );
          }
          if (text) candidates.push("internal:text=" + JSON.stringify(text) + "i");
          if (candidates.length === 0) candidates.push(tagName);
          return {
            ariaName,
            boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            nodeId: null,
            preview: element.outerHTML.slice(0, 300),
            role,
            selector: {
              candidates,
              primary: candidates[0] || null,
            },
            tagName,
            testId,
            visibleText: text || null,
          };
        });
    }`, options);
  }

  async elementScreenshot(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<Uint8Array> {
    validatePointOptions(options, "elementScreenshot");
    const [first] = await this.elementInfo(options);
    if (first?.boundingBox != null) {
      await cdp(this.#tab, "Overlay.enable").catch(() => {});
      await cdp(this.#tab, "Overlay.highlightRect", {
        ...first.boundingBox,
        color: { r: 80, g: 170, b: 255, a: 0.35 },
        outlineColor: { r: 37, g: 99, b: 235, a: 0.95 },
      }).catch(() => {});
    }
    try {
      return await this.#tab.screenshot();
    } finally {
      await cdp(this.#tab, "Overlay.hideHighlight").catch(() => {});
    }
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("waitForTimeout requires a non-negative integer");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  }

  waitForLoadState(options: {
    state?: "load" | "domcontentloaded" | "networkidle";
    timeoutMs?: number;
  } = {}): Promise<void> {
    const state = supportedLoadState(options.state);
    return waitForTabLoadState(this.#tab, state, timeoutOf(options));
  }

  async waitForURL(
    url: string,
    options: { timeoutMs?: number; waitUntil?: WaitUntil } = {},
  ): Promise<void> {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("waitForURL requires a URL");
    }
    supportedWaitUntil(options.waitUntil);
    if (options.waitUntil === "networkidle") supportedLoadState(options.waitUntil);
    const timeoutMs = timeoutOf(options);
    const expected = globUrlPattern(url);
    const started = Date.now();
    for (;;) {
      const current = await this.#tab.url();
      if (current != null && expected.test(current)) break;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for URL ${url}`);
      }
      await this.waitForTimeout(RETRY_INTERVAL_MS);
    }
    if (options.waitUntil === "load" || options.waitUntil === "domcontentloaded") {
      await this.waitForLoadState({ state: options.waitUntil, timeoutMs });
    }
  }

  async expectNavigation<T>(
    action: () => Promise<T>,
    options: {
      timeoutMs?: number;
      url?: string;
      waitUntil?: WaitUntil;
    } = {},
  ): Promise<T> {
    if (options.url !== undefined && (typeof options.url !== "string" || options.url.length === 0)) {
      throw new Error("expectNavigation url must be a non-empty string");
    }
    supportedWaitUntil(options.waitUntil);
    if (options.waitUntil === "networkidle") supportedLoadState(options.waitUntil);
    const timeoutMs = timeoutOf(options);
    const navigation = options.url != null
      ? this.waitForURL(options.url, {
          timeoutMs,
          ...(options.waitUntil != null ? { waitUntil: options.waitUntil } : {}),
        })
      : this.waitForLoadState({
          timeoutMs,
          ...(options.waitUntil === "load" || options.waitUntil === "domcontentloaded"
            ? { state: options.waitUntil }
            : {}),
        });
    const actionResult = action();
    const [result] = await Promise.all([actionResult, navigation]);
    return result;
  }

  async waitForEvent(
    event: "download",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightDownload>;
  async waitForEvent(
    event: "filechooser",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightFileChooser>;
  async waitForEvent(
    event: "download" | "filechooser",
    options: { timeoutMs?: number } = {},
  ): Promise<PlaywrightDownload | PlaywrightFileChooser> {
    if (event !== "download" && event !== "filechooser") {
      throw new Error(`Unsupported Playwright event: ${String(event)}`);
    }
    const timeoutMs = timeoutOf(options);
    if (event === "download") {
      await ensureFileTransferAllowed(await this.#tab.url() ?? "", "download");
      let off = (): void => {};
      const first = new Promise<PlaywrightDownload>((resolve) => {
        off = onTabDownloadChange(this.#tab, (initial) => {
          off();
          let completionOff = (): void => {};
          const completion = new Promise<string | null>((resolvePath, rejectPath) => {
            const consume = (change: typeof initial) => {
              if (change.id !== initial.id) return;
              if (change.status === "complete") {
                completionOff();
                resolvePath(change.filename || null);
              } else if (change.status === "canceled" || change.status === "failed") {
                completionOff();
                rejectPath(new Error(`Download ${change.status}: ${change.url}`));
              }
            };
            completionOff = onTabDownloadChange(this.#tab, consume);
            consume(initial);
          });
          resolve(new PlaywrightDownload(completion));
        });
      });
      return await withTimeout(first, timeoutMs, "download event").finally(off);
    }
    await cdp(this.#tab, "Page.enable");
    await cdp(this.#tab, "Page.setInterceptFileChooserDialog", { enabled: true });
    let off = (): void => {};
    const chooser = new Promise<PlaywrightFileChooser>((resolve, reject) => {
      off = onTabCdpEvent(this.#tab, (notification) => {
        if (notification.method !== "Page.fileChooserOpened") return;
        const params = (notification.params ?? {}) as { backendNodeId?: number; mode?: string };
        if (typeof params.backendNodeId !== "number") return;
        off();
        if (notification.source.sessionId != null || notification.source.targetId != null) {
          reject(new Error("File uploads in out-of-process frames are not supported."));
          return;
        }
        resolve(new PlaywrightFileChooser(
          this.#tab,
          params.backendNodeId,
          params.mode === "selectMultiple",
        ));
      });
    });
    try {
      return await withTimeout(chooser, timeoutMs, "file chooser");
    } finally {
      off();
      await cdp(
        this.#tab,
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
      ).catch(() => {});
    }
  }
}
