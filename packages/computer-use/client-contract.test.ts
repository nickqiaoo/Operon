// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { MacComputerUseClient } from "./computer/client.ts";
import {
  API_VERSION,
  decodeMessageFrames,
  encodeMessageFrame,
  type NativePipeConnection,
} from "./computer/wire.ts";

type DataListener = (chunk: Uint8Array) => void;
type ErrorListener = (error: Error) => void;

class FakePipe implements NativePipeConnection {
  readonly messages: Array<{
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  readonly #dataListeners = new Set<DataListener>();
  readonly #errorListeners = new Set<ErrorListener>();

  write(data: Uint8Array): void {
    const { messages } = decodeMessageFrames(Buffer.from(data));
    for (const raw of messages) {
      const message = JSON.parse(raw) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      this.messages.push(message);
      if (message.method === "ping") {
        this.respond(message.id, { serverApiVersion: API_VERSION });
      }
    }
  }

  end(): void {}

  on(event: "data" | "error" | "close", listener: DataListener | ErrorListener | (() => void)): void {
    if (event === "data") this.#dataListeners.add(listener as DataListener);
    if (event === "error") this.#errorListeners.add(listener as ErrorListener);
  }

  respond(id: number, result: unknown): void {
    const frame = encodeMessageFrame(JSON.stringify({ jsonrpc: "2.0", id, result }));
    queueMicrotask(() => {
      for (const listener of this.#dataListeners) listener(frame);
    });
  }
}

function install(pipe: FakePipe): void {
  (globalThis as Record<string, unknown>).nodeRepl = {
    nativePipe: { createConnection: async () => pipe },
    env: { SKY_CUA_NATIVE_PIPE_PATH: "/tmp/fake-computer-use.sock" },
    requestMeta: {
      "x-codex-turn-metadata": { session_id: "session-from-header", turn_id: "turn-2" },
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).nodeRepl;
});

describe("Computer Use client parity contract", () => {
  it("uses 120 seconds by default and forwards header-scoped turn metadata", async () => {
    const pipe = new FakePipe();
    install(pipe);
    const client = new MacComputerUseClient();
    const pending = client.listApps();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = pipe.messages.find((message) => message.method === "request");
    expect(request?.params?.codexTurnMetadata).toEqual({
      session_id: "session-from-header",
      turn_id: "turn-2",
    });
    const remaining = Number(request?.params?.deadlineUnixMilliseconds) - Date.now();
    expect(remaining).toBeGreaterThan(119_000);
    expect(remaining).toBeLessThanOrEqual(120_000);
    pipe.respond(request!.id, []);
    await expect(pending).resolves.toEqual([]);
  });

  it("serializes requests on a shared connection", async () => {
    const pipe = new FakePipe();
    install(pipe);
    const client = new MacComputerUseClient();
    const first = client.listApps();
    const second = client.listApps();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let requests = pipe.messages.filter((message) => message.method === "request");
    expect(requests).toHaveLength(1);
    pipe.respond(requests[0].id, []);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    requests = pipe.messages.filter((message) => message.method === "request");
    expect(requests).toHaveLength(2);
    pipe.respond(requests[1].id, []);
    await expect(second).resolves.toEqual([]);
  });
});
