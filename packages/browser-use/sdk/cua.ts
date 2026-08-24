/**
 * The CUA (Computer-Use-style) control surface: screenshots and coordinates.
 *
 * How it divides from the locator layer, which should not be mixed with it:
 * - The locator layer is the main path. It locates semantically by role, label or
 *   text, waits for the element to be ready, verifies the hit, and survives a
 *   re-render.
 * - CUA is the fallback, for pages that cannot be inspected at all: canvas,
 *   `<embed>`, self-drawn UI. The model looks at a screenshot and supplies
 *   coordinates. It waits for nothing and verifies nothing: it clicks exactly
 *   where it is told. Prefer a locator whenever one will do.
 *
 * Coordinates are main-frame viewport coordinates and correspond one-to-one with
 * the pixels of `tab.screenshot()`. No DPR conversion is applied, because
 * screenshots and input share the same CSS pixel coordinate space.
 */
import type { Tab } from "./index.ts";
import { cdp } from "./internals.ts";

export type CuaButton = 1 | 2 | 3 | 4 | 5;
type CdpButton = "left" | "middle" | "right" | "back" | "forward";

interface KeyDescriptor {
  code: string;
  key: string;
  text?: string;
  vk: number;
}

const SPECIAL_KEYS: Record<string, KeyDescriptor> = {
  ALT: { code: "AltLeft", key: "Alt", vk: 18 },
  ARROWDOWN: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  ARROWLEFT: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  ARROWRIGHT: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  ARROWUP: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  BACKSPACE: { code: "Backspace", key: "Backspace", vk: 8 },
  CONTROL: { code: "ControlLeft", key: "Control", vk: 17 },
  CTRL: { code: "ControlLeft", key: "Control", vk: 17 },
  DELETE: { code: "Delete", key: "Delete", vk: 46 },
  END: { code: "End", key: "End", vk: 35 },
  ENTER: { code: "Enter", key: "Enter", text: "\r", vk: 13 },
  ESC: { code: "Escape", key: "Escape", vk: 27 },
  ESCAPE: { code: "Escape", key: "Escape", vk: 27 },
  HOME: { code: "Home", key: "Home", vk: 36 },
  META: { code: "MetaLeft", key: "Meta", vk: 91 },
  CMD: { code: "MetaLeft", key: "Meta", vk: 91 },
  PAGEUP: { code: "PageUp", key: "PageUp", vk: 33 },
  PAGEDOWN: { code: "PageDown", key: "PageDown", vk: 34 },
  SHIFT: { code: "ShiftLeft", key: "Shift", vk: 16 },
  SPACE: { code: "Space", key: " ", text: " ", vk: 32 },
  TAB: { code: "Tab", key: "Tab", text: "\t", vk: 9 },
};

function descriptorFor(key: string): KeyDescriptor {
  const special = SPECIAL_KEYS[key.toUpperCase()];
  if (special != null) return special;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      code: /^[A-Z]$/u.test(upper)
        ? `Key${upper}`
        : /^[0-9]$/u.test(key) ? `Digit${key}` : key,
      key,
      text: key,
      vk: upper.charCodeAt(0),
    };
  }
  return { code: key, key, vk: 0 };
}

function modifierBit(key: string): number {
  switch (descriptorFor(key).key) {
    case "Alt": return 1;
    case "Control": return 2;
    case "Meta": return 4;
    case "Shift": return 8;
    default: return 0;
  }
}

function requireKeys(value: unknown, method: string, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (
    !Array.isArray(value)
    || (!optional && value.length === 0)
    || value.some((key) => typeof key !== "string")
  ) {
    throw new Error(
      optional
        ? `${method} keys must be an array of strings`
        : `${method} requires a non-empty keys array`,
    );
  }
  return value;
}

function requirePoint(
  options: { x: number; y: number } | undefined,
  method: string,
): { x: number; y: number } {
  if (
    options == null
    || !Number.isFinite(options.x)
    || !Number.isFinite(options.y)
  ) {
    throw new Error(`${method} requires x and y`);
  }
  return { x: options.x, y: options.y };
}

function buttonInfo(value: number | undefined): {
  button: CdpButton;
  buttons: number;
} {
  const button = value ?? 1;
  switch (button) {
    case 1: return { button: "left", buttons: 1 };
    case 2: return { button: "middle", buttons: 4 };
    case 3: return { button: "right", buttons: 2 };
    case 4: return { button: "back", buttons: 8 };
    case 5: return { button: "forward", buttons: 16 };
    default: throw new Error("cua.click button must be an integer from 1 through 5");
  }
}

async function withHeldKeys<T>(
  tab: Tab,
  keys: string[],
  action: (modifiers: number) => Promise<T>,
): Promise<T> {
  let modifiers = 0;
  const pressed: Array<{ descriptor: KeyDescriptor; modifier: number }> = [];
  try {
    for (const key of keys) {
      const descriptor = descriptorFor(key);
      const modifier = modifierBit(key);
      modifiers |= modifier;
      await cdp(tab, "Input.dispatchKeyEvent", {
        type: "keyDown",
        code: descriptor.code,
        key: descriptor.key,
        modifiers,
        nativeVirtualKeyCode: descriptor.vk,
        windowsVirtualKeyCode: descriptor.vk,
      });
      pressed.push({ descriptor, modifier });
    }
    return await action(modifiers);
  } finally {
    for (const { descriptor, modifier } of pressed.reverse()) {
      await cdp(tab, "Input.dispatchKeyEvent", {
        type: "keyUp",
        code: descriptor.code,
        key: descriptor.key,
        modifiers,
        nativeVirtualKeyCode: descriptor.vk,
        windowsVirtualKeyCode: descriptor.vk,
      }).catch(() => {});
      modifiers &= ~modifier;
    }
  }
}

export class CuaApi {
  readonly #tab: Tab;

  constructor(tab: Tab) {
    this.#tab = tab;
  }

  move(options: { x: number; y: number; keys?: string[] }): Promise<void> {
    const { x, y } = requirePoint(options, "cua.move");
    const keys = requireKeys(options?.keys, "cua.move", true);
    return withHeldKeys(this.#tab, keys, async (modifiers) => {
      await cdp<void>(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "none", buttons: 0, modifiers, x, y,
      });
    });
  }

  async click(options: {
    x: number;
    y: number;
    button?: CuaButton;
    keypress?: string[];
  }): Promise<void> {
    const { x, y } = requirePoint(options, "cua.click");
    const { button, buttons } = buttonInfo(options?.button);
    const keys = requireKeys(options?.keypress, "cua.click", true);
    await withHeldKeys(this.#tab, keys, async (modifiers) => {
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "none", buttons: 0, modifiers, x, y,
      });
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mousePressed", button, buttons, clickCount: 1, modifiers, x, y,
      });
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseReleased", button, buttons: 0, clickCount: 1, modifiers, x, y,
      });
    });
  }

  async double_click(options: {
    x: number;
    y: number;
    keypress?: string[];
  }): Promise<void> {
    const { x, y } = requirePoint(options, "cua.double_click");
    const keys = requireKeys(options?.keypress, "cua.double_click", true);
    await withHeldKeys(this.#tab, keys, async (modifiers) => {
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "none", buttons: 0, modifiers, x, y,
      });
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mousePressed", button: "left", buttons: 1, clickCount: 2, modifiers, x, y,
      });
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseReleased", button: "left", buttons: 0, clickCount: 2, modifiers, x, y,
      });
    });
  }

  async downloadMedia(options: { x: number; y: number; timeoutMs?: number }): Promise<void> {
    const pending = this.#tab.playwright.waitForEvent("download", {
      timeoutMs: options.timeoutMs,
    });
    await this.click(options);
    const download = await pending;
    await download.path({ timeoutMs: options.timeoutMs });
  }

  /** Drag along a path of waypoints. Without the intermediate points many HTML5
   *  drag implementations do not recognise it as a drag. */
  async drag(options: {
    path: Array<{ x: number; y: number }>;
    keys?: string[];
  }): Promise<void> {
    const path = options?.path;
    if (
      !Array.isArray(path)
      || path.length === 0
      || path.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
    ) {
      throw new Error("cua.drag requires a non-empty path of {x, y} points");
    }
    const keys = requireKeys(options?.keys, "cua.drag", true);
    const first = path[0];
    const last = path[path.length - 1];
    await withHeldKeys(this.#tab, keys, async (modifiers) => {
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "none", buttons: 0, modifiers, x: first.x, y: first.y,
      });
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mousePressed", button: "left", buttons: 1, clickCount: 1,
        modifiers, x: first.x, y: first.y,
      });
      for (const point of path.slice(1)) {
        await cdp(this.#tab, "Input.dispatchMouseEvent", {
          type: "mouseMoved", button: "left", buttons: 1,
          modifiers, x: point.x, y: point.y,
        });
      }
      await cdp(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseReleased", button: "left", buttons: 0, clickCount: 1,
        modifiers, x: last.x, y: last.y,
      });
    });
  }

  /** Scroll from a coordinate. `Input.dispatchMouseEvent`'s mouseWheel is a real
   *  wheel event; scrollBy fires none. */
  scroll(options: {
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
    keypress?: string[];
  }): Promise<void> {
    const { x, y } = requirePoint(options, "cua.scroll");
    if (!Number.isFinite(options?.scrollX) || !Number.isFinite(options?.scrollY)) {
      throw new Error("cua.scroll requires x, y, scrollX, and scrollY");
    }
    const keys = requireKeys(options?.keypress, "cua.scroll", true);
    return withHeldKeys(this.#tab, keys, async (modifiers) => {
      await cdp<void>(this.#tab, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, modifiers,
        deltaX: options.scrollX, deltaY: options.scrollY,
      });
    });
  }

  /** Type at the current focus; click first to place it. */
  type(options: { text: string }): Promise<void> {
    if (typeof options?.text !== "string") {
      return Promise.reject(new Error("cua.type requires text"));
    }
    return cdp<void>(this.#tab, "Input.insertText", { text: options.text });
  }

  /**
   * Press a chord. `keys` are held together, for example `["Control","a"]`:
   * keyDown in order, keyUp in reverse, the way a real keyboard behaves.
   */
  async keypress(options: { keys: string[] }): Promise<void> {
    const keys = requireKeys(options?.keys, "cua.keypress");
    await withHeldKeys(this.#tab, keys, async () => {});
  }
}


/**
 * `tab.dom_cua`: the node-id flavour. Call `get_visible_dom()` for a table of
 * interactive elements with ids, then act on them by id.
 *
 * Where it sits among the three paths:
 * - `playwright.domSnapshot()` plus locators is the main path: semantic, waits,
 *   verifies.
 * - `cua.*` works in coordinates and is the fallback for a page that cannot be
 *   inspected at all.
 * - `dom_cua.*`, this class, sits between them: the DOM is reachable but its
 *   semantics are poor, as with self-drawn components carrying no role or label.
 *   It resolves an element by id, converts to coordinates and then dispatches
 *   real input, so a click here means the same thing it does through a locator,
 *   and is not `el.click()`.
 *
 * An id is only valid within the snapshot from one `get_visible_dom()` call;
 * once the page changes, take a fresh one.
 */
export class DomCuaApi {
  readonly #tab: Tab;

  constructor(tab: Tab) {
    this.#tab = tab;
  }

  /**
   * A filtered DOM of interactive elements. Each one is tagged with
   * `data-operon-dom-id` and returned in a flat table.
   *
   * Only elements that are both visible and meaningfully interactive are
   * collected: clickable, editable, or carrying a role. Returning every div on a
   * page would be useless.
   */
  async get_visible_dom(): Promise<Array<{ id: string; tag: string; type?: string; text?: string; label?: string }>> {
    const r = await cdp<{ result?: { value?: Array<{ id: string; tag: string; type?: string; text?: string; label?: string }> } }>(
      this.#tab,
      "Runtime.evaluate",
      {
        expression: `(() => {
          const SEL = 'a,button,input,select,textarea,summary,[role],[onclick],[contenteditable=""],[contenteditable="true"],[tabindex]';
          const out = [];
          let id = 0;
          for (const el of document.querySelectorAll(SEL)) {
            const r = el.getBoundingClientRect();
            // Skip invisible and zero-sized elements: templates and display:none
            // mobile copies would otherwise swamp the result.
            if (r.width <= 0 || r.height <= 0) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
            id += 1;
            el.setAttribute("data-operon-dom-id", String(id));
            const text = (el.innerText || el.textContent || "").trim().slice(0, 80);
            out.push({
              id: String(id),
              tag: el.tagName.toLowerCase(),
              ...(el.type ? { type: String(el.type) } : {}),
              ...(text ? { text } : {}),
              ...(el.getAttribute("aria-label") ? { label: el.getAttribute("aria-label") } : {}),
            });
          }
          return out;
        })()`,
        returnByValue: true,
      },
    );
    return r?.result?.value ?? [];
  }

  /** Resolve a node id to main-frame viewport coordinates, scrolling it into view. */
  async #pointFor(nodeId: unknown, method: string): Promise<{ x: number; y: number }> {
    if (typeof nodeId !== "string") {
      throw new Error(`${method} node_id must be a string`);
    }
    if (nodeId.length === 0) {
      throw new Error(`${method} node_id must not be empty`);
    }
    const r = await cdp<{ result?: { value?: { found: boolean; x: number; y: number } } }>(this.#tab, "Runtime.evaluate", {
      expression: `(() => {
        const nodeId = ${JSON.stringify(nodeId)};
        const el = [...document.querySelectorAll("[data-operon-dom-id]")]
          .find((candidate) => candidate.getAttribute("data-operon-dom-id") === nodeId);
        if (!el) return { found: false, x: 0, y: 0 };
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        const b = el.getBoundingClientRect();
        return { found: true, x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })()`,
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (v?.found !== true) {
      throw new Error(`No node with id ${nodeId} — the snapshot is stale, call get_visible_dom() again`);
    }
    return { x: v.x, y: v.y };
  }

  async click(options: { node_id: string }): Promise<void> {
    const p = await this.#pointFor(options?.node_id, "dom_cua.click");
    await this.#tab.cua.click(p);
  }

  async double_click(options: { node_id: string }): Promise<void> {
    const p = await this.#pointFor(options?.node_id, "dom_cua.double_click");
    await this.#tab.cua.double_click(p);
  }

  /** With a node_id, scroll that element; otherwise scroll the page. */
  async downloadMedia(options: { node_id: string; timeoutMs?: number }): Promise<void> {
    if (typeof options?.node_id !== "string" || options.node_id.length === 0) {
      throw new Error("dom_cua.downloadMedia requires a node_id");
    }
    const pending = this.#tab.playwright.waitForEvent("download", {
      timeoutMs: options.timeoutMs,
    });
    await this.click({ node_id: options.node_id });
    const download = await pending;
    await download.path({ timeoutMs: options.timeoutMs });
  }

  async scroll(options: { node_id?: string; x: number; y: number }): Promise<void> {
    if (!Number.isFinite(options?.x) || !Number.isFinite(options?.y)) {
      throw new Error("dom_cua.scroll requires x and y numbers");
    }
    const p = options.node_id == null
      ? { x: 10, y: 10 }
      : await this.#pointFor(options.node_id, "dom_cua.scroll");
    await this.#tab.cua.scroll({
      ...p,
      scrollX: options.x,
      scrollY: options.y,
    });
  }

  /** Type at the current focus; `click` first to place it. */
  type(options: { text: string }): Promise<void> {
    if (typeof options?.text !== "string") {
      return Promise.reject(new Error("dom_cua.type requires text"));
    }
    return this.#tab.cua.type(options);
  }

  keypress(options: { keys: string[] }): Promise<void> {
    requireKeys(options?.keys, "dom_cua.keypress");
    return this.#tab.cua.keypress(options);
  }
}
