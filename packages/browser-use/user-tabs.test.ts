// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Browser } from "./sdk/index.ts";

/**
 * `openTabs()` -> `claimTab(tab)` must round-trip.
 *
 * It did not: `openTabs()` passed the wire's numeric id straight through while
 * `claimTab` accepted only strings, so the object `openTabs()` handed out was
 * rejected by the very next call. Stringifying it by hand then failed at the
 * extension backend, which requires an integer `tabId`. Taking over a tab the
 * user already had open was impossible on Chrome.
 */

interface Call {
  method: string;
  params: unknown;
}

function browserWith(userTabs: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const conn = {
    sendSessionRequest: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "getUserTabs") return userTabs;
      if (method === "claimUserTab") return { id: (params as { tabId: number }).tabId };
      return {};
    },
    onCdpEvent: () => () => {},
    onDownloadChange: () => () => {},
    close: () => {},
  };
  const browser = new Browser({
    conn,
    info: {
      id: "x",
      name: "x",
      type: "extension",
      capabilities: {},
      apiSupportOverrides: { "BrowserUser.claimTab": true },
    },
    socketPath: "/tmp/x",
  } as never);
  return { browser, calls };
}

describe("browser.user open tabs", () => {
  it("reports tab ids as strings, like tabs.list() does", async () => {
    const { browser } = browserWith([
      { id: 1257134012, title: "主页 / X", url: "https://x.com/home", lastOpened: "2026-09-04T07:39:56.884Z", tabGroup: "查看X时间线" },
    ]);
    const [tab] = await browser.user.openTabs();
    expect(tab).toEqual({
      id: "1257134012",
      title: "主页 / X",
      url: "https://x.com/home",
      lastOpened: "2026-09-04T07:39:56.884Z",
      tabGroup: "查看X时间线",
    });
  });

  it("claims the exact object openTabs() returned", async () => {
    const { browser, calls } = browserWith([{ id: 1257134012, url: "https://x.com/home" }]);
    const [info] = await browser.user.openTabs();
    const tab = await browser.user.claimTab(info!);
    expect(tab.id).toBe("1257134012");
    // The extension backend rejects anything but an integer here.
    expect(calls.find((c) => c.method === "claimUserTab")?.params).toEqual({ tabId: 1257134012 });
  });

  it("accepts a bare id as a string or a number", async () => {
    for (const id of ["1257134012", 1257134012]) {
      const { browser, calls } = browserWith([]);
      await browser.user.claimTab(id);
      expect(calls.at(-1)?.params).toEqual({ tabId: 1257134012 });
    }
  });

  it("rejects ids that are not tab ids", async () => {
    const { browser } = browserWith([]);
    for (const bad of ["", "abc", 0, -1, 1.5, null, undefined, {}, { id: "abc" }]) {
      await expect(browser.user.claimTab(bad as never)).rejects.toThrow(
        /expects a tab returned by browser\.user\.openTabs\(\)/,
      );
    }
  });
});
