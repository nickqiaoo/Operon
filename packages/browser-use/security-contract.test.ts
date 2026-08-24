// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtimeEntry from "./sdk/runtime.ts";
import { ensureFileTransferAllowed, ensureNavigationAllowed } from "./sdk/security.ts";

interface SecurityHarness {
  readRequirements: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  readToml: ReturnType<typeof vi.fn>;
  writeToml: ReturnType<typeof vi.fn>;
  createElicitation: ReturnType<typeof vi.fn>;
}

function installSecurityHarness(args: {
  requirements?: unknown;
  browserConfig?: Record<string, unknown>;
  elicitation?: {
    action: string;
    _meta?: {
      persist?: "session" | "always";
      approvals_reviewer?: "auto_review" | "guardian_subagent";
    };
  };
} = {}): SecurityHarness {
  const files = new Map<string, unknown>([
    ["browser/config.toml", args.browserConfig ?? {}],
  ]);
  const harness: SecurityHarness = {
    readRequirements: vi.fn(async () => args.requirements ?? {
      requirements: { network: { enabled: true } },
    }),
    read: vi.fn(async () => ({})),
    readToml: vi.fn(async (path: string) => files.get(path) ?? {}),
    writeToml: vi.fn(async (path: string, value: unknown) => {
      files.set(path, value);
    }),
    createElicitation: vi.fn(async () => args.elicitation ?? { action: "accept" }),
  };
  (globalThis as Record<string, unknown>).nodeRepl = {
    cwd: "/tmp/work",
    requestMeta: {
      "x-codex-turn-metadata": { session_id: "security-session", turn_id: "turn-1" },
    },
    config: {
      readRequirements: harness.readRequirements,
      read: harness.read,
      readToml: harness.readToml,
      writeToml: harness.writeToml,
    },
    createElicitation: harness.createElicitation,
  };
  return harness;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).nodeRepl;
});

describe("Browser runtime security contract", () => {
  it("packaged runtime entry exposes setup only, not raw transport or discovery", () => {
    expect(Object.keys(runtimeEntry).sort()).toEqual(["setupBrowserRuntime"]);
  });

  it("fails closed when no trusted node repl policy bridge exists", async () => {
    await expect(ensureNavigationAllowed("https://example.com")).rejects.toThrow(
      "Browser security unavailable outside node repl",
    );
  });

  it("enforces the managed domain allowlist before asking the user", async () => {
    const harness = installSecurityHarness({
      requirements: {
        requirements: {
          network: {
            enabled: true,
            managedAllowedDomainsOnly: true,
            allowedDomains: ["example.com"],
          },
        },
      },
      browserConfig: { approval_mode: "never_ask" },
    });
    await expect(ensureNavigationAllowed("https://example.com/path")).resolves.toBeUndefined();
    await expect(ensureNavigationAllowed("https://blocked.example/path")).rejects.toThrow(
      "not present in the managed browser allowlist",
    );
    expect(harness.createElicitation).not.toHaveBeenCalled();
  });

  it("persists an explicit origin approval at session scope", async () => {
    const harness = installSecurityHarness({
      elicitation: { action: "accept", _meta: { persist: "session" } },
    });
    await ensureNavigationAllowed("https://example.com/a");
    expect(harness.createElicitation).toHaveBeenCalledTimes(1);
    expect(harness.writeToml).toHaveBeenCalledWith(
      "browser/sessions/security-session.toml",
      expect.objectContaining({
        origins: expect.objectContaining({ allowed: ["https://example.com"] }),
      }),
    );
  });

  it("keeps an auto-reviewed origin in the current-turn cache without persisting it", async () => {
    const harness = installSecurityHarness({
      elicitation: {
        action: "accept",
        _meta: { approvals_reviewer: "auto_review" },
      },
    });
    await ensureNavigationAllowed("https://example.com/a");
    await ensureNavigationAllowed("https://example.com/b");
    expect(harness.createElicitation).toHaveBeenCalledTimes(1);
    expect(harness.writeToml).not.toHaveBeenCalled();

    const repl = (globalThis as unknown as {
      nodeRepl: { requestMeta: { "x-codex-turn-metadata": Record<string, unknown> } };
    }).nodeRepl;
    repl.requestMeta["x-codex-turn-metadata"].turn_id = "turn-2";
    await ensureNavigationAllowed("https://example.com/c");
    expect(harness.createElicitation).toHaveBeenCalledTimes(2);
  });

  it("applies the same current-turn cache semantics to Guardian approvals", async () => {
    const harness = installSecurityHarness({
      elicitation: {
        action: "accept",
        _meta: { approvals_reviewer: "guardian_subagent" },
      },
    });
    const repl = (globalThis as unknown as {
      nodeRepl: { requestMeta: { "x-codex-turn-metadata": Record<string, unknown> } };
    }).nodeRepl;
    repl.requestMeta["x-codex-turn-metadata"].session_id = "guardian-session";

    await ensureNavigationAllowed("https://guardian.example/a");
    await ensureNavigationAllowed("https://guardian.example/b");
    expect(harness.createElicitation).toHaveBeenCalledTimes(1);
    expect(harness.writeToml).not.toHaveBeenCalled();
  });

  it("denials are fail-closed and explicitly forbid workaround paths", async () => {
    installSecurityHarness({ elicitation: { action: "decline" } });
    await expect(ensureFileTransferAllowed("https://example.com/report", "download"))
      .rejects.toThrow("must not attempt to achieve the same outcome via workaround");
  });

  it("rejects non-http navigation without elicitation", async () => {
    const harness = installSecurityHarness();
    await expect(ensureNavigationAllowed("file:///tmp/private")).rejects.toThrow(
      "cannot visit URLs using the file: protocol",
    );
    expect(harness.createElicitation).not.toHaveBeenCalled();
  });
});
