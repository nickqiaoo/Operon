// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IabBackend, type CdpDriver } from "./IabBackend.ts";
import { BUILD_FLAVOR_ENV } from "./wire.ts";
import {
  closeBrowser,
  setupBrowserRuntime,
  type Tab,
  type Browser as SdkBrowser,
} from "./sdk/index.ts";

/**
 * The half of Tab that the documentation promises but nothing tested, checked
 * against a real IabBackend as the oracle.
 *
 * ## Why this file exists
 *
 * `back`, `forward`, `reload` and `finalize` are all documented in
 * `sdk/documentation.ts`, which is the model's only source of truth for the API,
 * and none of them had a single test. 248 tests were green and covered none of
 * them. That is the same cause as the last two regressions: the tests asked
 * whether the implementation was correct, not whether what callers need is
 * actually there.
 *
 * ## Why a real backend rather than asserting frames against a fake driver
 *
 * A fake driver can only prove that we sent what we thought we were sending. A
 * real IabBackend rejects a wrong shape, and `finalizeTabs` produces an
 * observable effect: a marked tab survives while an unmarked one is closed. That
 * is far stronger than asserting against your own implementation. The CDP side
 * (back, forward, reload) is verified at the driver, because correctness there is
 * about which CDP commands were sent and whether the entryId was computed right.
 */

const SESSION = "TABWIRE";
const FLAVOR = "operon-tabwire";

interface CdpCall {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

describe("Tab's documented surface, over the wire, with a real IabBackend as oracle", () => {
  let hidden: string;
  let backend: IabBackend;
  let browser: SdkBrowser;
  const cdpCalls: CdpCall[] = [];
  const closed: number[] = [];
  const cdpSubscribers = new Set<(event: {
    source: { tabId: number };
    method: string;
    params?: unknown;
  }) => void>();
  let nextTabId = 1;
  /** Lets a test control what Page.getNavigationHistory returns, for edge cases. */
  let history: { currentIndex: number; entries: Array<{ id: number }> } = {
    currentIndex: 1,
    entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
  };

  beforeAll(async () => {
    hidden = fs.mkdtempSync(path.join(os.tmpdir(), "tabwire-"));

    const emitNavigation = (tabId: number) => {
      queueMicrotask(() => {
        for (const subscriber of cdpSubscribers) {
          subscriber({
            source: { tabId },
            method: "Page.frameNavigated",
            params: { frame: { id: "main", url: "https://example.com/" } },
          });
          subscriber({
            source: { tabId },
            method: "Page.loadEventFired",
            params: {},
          });
        }
      });
    };
    const driver: CdpDriver = {
      onCdpEvent: (subscriber) => {
        cdpSubscribers.add(subscriber);
        return () => cdpSubscribers.delete(subscriber);
      },
      attach: async () => {},
      detach: async () => {},
      listTabs: async () => [],
      createTab: async (url, owner) =>
        ({ id: ++nextTabId, title: "n", url: url ?? "", active: true, owner }) as never,
      closeTab: async (id) => {
        closed.push(id);
      },
      sendCommand: async (tabId, method, params) => {
        cdpCalls.push({ tabId, method, params: (params ?? {}) as Record<string, unknown> });
        // cdp() hands the driver's return value straight back as the CDP result
        // (see executeCdpRequest).
        if (method === "Page.getNavigationHistory") return history;
        if (method === "Page.navigateToHistoryEntry" || method === "Page.reload") {
          emitNavigation(tabId);
        }
        return {};
      },
    };

    backend = new IabBackend({ driver, socketDir: hidden, buildFlavor: FLAVOR } as never);
    await backend.listen();

    (globalThis as Record<string, unknown>).nodeRepl = {
      nativePipe: {
        createConnection: (p: string) =>
          new Promise((res, rej) => {
            const s = net.createConnection(p);
            s.once("connect", () => res(s));
            s.once("error", rej);
          }),
      },
      requestMeta: { "x-codex-turn-metadata": { session_id: SESSION, turn_id: "T1" } },
      env: { [BUILD_FLAVOR_ENV]: FLAVOR },
    };

    const globals: Record<string, unknown> = {};
    // Point socketDir at a private temp directory, so this backend and other
    // tests cannot discover each other.
    await setupBrowserRuntime({ globals, socketDir: hidden });
    const agent = globals.agent as { browsers: { get(id: string): Promise<SdkBrowser> } };
    browser = await agent.browsers.get("iab");
  }, 60_000);

  afterAll(async () => {
    if (browser != null) closeBrowser(browser);
    await backend.close?.();
    fs.rmSync(hidden, { recursive: true, force: true });
  });

  it("the API view exposes no internal mark method; disposition is declared through tabs.finalize", async () => {
    const t = await browser.tabs.new();
    expect("markTab" in t).toBe(false);
    expect((t as unknown as { markTab?: unknown }).markTab).toBeUndefined();
    expect("markDeliverable" in t).toBe(false);
    expect("markHandoff" in t).toBe(false);
  });

  /**
   * A genuinely observable effect: finalize keeps a marked tab and closes an
   * unmarked one. That is stronger than asserting "markTab was sent", because it
   * proves the backend really recorded the state against that tab.
   */
  it("finalize keeps a deliverable tab and closes an unmarked one", async () => {
    const keep = await browser.tabs.new();
    const drop = await browser.tabs.new();
    closed.length = 0;

    await browser.tabs.finalize({
      keep: [{ tab: keep, status: "deliverable" }],
    });

    expect(closed, `the deliverable tab ${keep.id} should not have been closed`).not.toContain(Number(keep.id));
    expect(closed, `the unmarked tab ${drop.id} should have been closed`).toContain(Number(drop.id));
  });

  /**
   * back and forward have to compute their entryId from getNavigationHistory:
   * `Page.navigateToHistoryEntry` takes an entryId, not a delta. With
   * currentIndex 1, back lands on entries[0] and forward on entries[2].
   */
  it("back calls getNavigationHistory, then navigateToHistoryEntry with the previous entryId", async () => {
    const t = await browser.tabs.new();
    cdpCalls.length = 0;
    await t.back();

    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toEqual(["Page.getNavigationHistory", "Page.navigateToHistoryEntry"]);
    expect(cdpCalls[1].params, "one step back from currentIndex 1 is entries[0].id = 10").toEqual({ entryId: 10 });
    expect(cdpCalls[1].tabId, "the CDP command has to land on this tab").toBe(Number(t.id));
  });

  it("forward uses the next entryId", async () => {
    const t = await browser.tabs.new();
    cdpCalls.length = 0;
    await t.forward();
    expect(cdpCalls.map((c) => c.method)).toEqual(["Page.getNavigationHistory", "Page.navigateToHistoryEntry"]);
    expect(cdpCalls[1].params, "one step forward from currentIndex 1 is entries[2].id = 12").toEqual({ entryId: 12 });
  });

  /** With no previous entry, the client raises a clear error. */
  it("at the start of history it throws clearly and sends no navigateToHistoryEntry", async () => {
    const t = await browser.tabs.new();
    const saved = history;
    history = { currentIndex: 0, entries: [{ id: 10 }] };
    cdpCalls.length = 0;
    await expect(t.back()).rejects.toThrow("Cannot navigate back");
    expect(cdpCalls.map((c) => c.method), "navigating past the end would jump to the wrong history entry").toEqual(["Page.getNavigationHistory"]);
    history = saved;
  });

  it("reload → Page.reload", async () => {
    const t = await browser.tabs.new();
    cdpCalls.length = 0;
    await t.reload();
    expect(cdpCalls.map((c) => c.method)).toEqual(["Page.reload"]);
    expect(cdpCalls[0].tabId).toBe(Number(t.id));
  });

  /** The model-facing id is a string; the wire layer still has to convert it back
   *  to the integer tabId the backend expects. */
  it("a string tab.id maps correctly to the wire tabId", async () => {
    const t = await browser.tabs.new();
    cdpCalls.length = 0;
    await t.reload();
    expect(cdpCalls[0].tabId).toBe(Number(t.id));
    expect(typeof t.id).toBe("string");
    expect(Number.isInteger(Number(t.id)) && Number(t.id) > 0).toBe(true);
  });
});
