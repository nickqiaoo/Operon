/**
 * The relay is dumb by design, so these tests care about exactly the things a dumb pipe can
 * still get wrong: id collisions between clients, replies going to the wrong client,
 * notifications not reaching everyone, and leaks when a client disappears mid-request.
 */
import { Buffer } from "node:buffer";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ChromeNativeHost } from "./ChromeNativeHost.ts";
import { decodeFrames, encodeFrame } from "./wire.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Stands in for the Chrome extension on the far side of the native messaging pipe. */
function fakeExtension() {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const received: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];

  fromHost.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, remainingData } = decodeFrames(buffer);
    buffer = remainingData;
    for (const raw of messages) received.push(JSON.parse(raw) as Record<string, unknown>);
    while (waiters.length && received.length) waiters.shift()?.();
  });

  return {
    stdin: toHost,
    stdout: fromHost,
    received,
    send(message: unknown) {
      toHost.write(encodeFrame(JSON.stringify(message)));
    },
    async next(count: number): Promise<Record<string, unknown>[]> {
      while (received.length < count) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 500);
        });
      }
      return received;
    },
  };
}

async function startHost() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-native-host-"));
  const extension = fakeExtension();
  const errors: Error[] = [];
  const host = new ChromeNativeHost({
    stdin: extension.stdin,
    stdout: extension.stdout,
    socketPath: path.join(dir, "host.sock"),
    onError: (error) => errors.push(error),
  });
  const socketPath = await host.listen();
  cleanups.push(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { host, extension, socketPath, errors };
}

/** Stands in for a browser-client connecting over the discovery socket. */
async function connectClient(socketPath: string) {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const received: Record<string, unknown>[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, remainingData } = decodeFrames(buffer);
    buffer = remainingData;
    for (const raw of messages) received.push(JSON.parse(raw) as Record<string, unknown>);
  });
  cleanups.push(async () => {
    socket.destroy();
  });
  return {
    socket,
    received,
    send(message: unknown) {
      socket.write(encodeFrame(JSON.stringify(message)));
    },
    async next(count: number): Promise<Record<string, unknown>[]> {
      const deadline = Date.now() + 1000;
      while (received.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return received;
    },
  };
}

describe("ChromeNativeHost", () => {
  it("forwards a request to the extension and the reply back to the client", async () => {
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    client.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    const [forwarded] = await extension.next(1);
    expect(forwarded.method).toBe("ping");

    extension.send({ jsonrpc: "2.0", id: forwarded.id, result: "pong" });
    const [reply] = await client.next(1);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
  });

  it("keeps two clients' identical ids apart", async () => {
    // Every client numbers its own requests from 1, so without rewriting, the second
    // client's id 1 would overwrite the first's and one of them would hang forever.
    const { extension, socketPath } = await startHost();
    const first = await connectClient(socketPath);
    const second = await connectClient(socketPath);

    first.send({ jsonrpc: "2.0", id: 1, method: "getTabs" });
    second.send({ jsonrpc: "2.0", id: 1, method: "getInfo" });
    const forwarded = await extension.next(2);
    expect(forwarded[0].id).not.toEqual(forwarded[1].id);

    // Reply out of order, to prove routing is by id and not by arrival.
    const getInfo = forwarded.find((m) => m.method === "getInfo");
    const getTabs = forwarded.find((m) => m.method === "getTabs");
    extension.send({ jsonrpc: "2.0", id: getInfo?.id, result: { type: "extension" } });
    extension.send({ jsonrpc: "2.0", id: getTabs?.id, result: [] });

    expect(await second.next(1)).toEqual([{ jsonrpc: "2.0", id: 1, result: { type: "extension" } }]);
    expect(await first.next(1)).toEqual([{ jsonrpc: "2.0", id: 1, result: [] }]);
  });

  it("restores the client's own id, whatever its type", async () => {
    // JSON-RPC ids may be strings; ours are always strings internally. A client that used
    // a string id must not get our internal id back.
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    client.send({ jsonrpc: "2.0", id: "client-abc", method: "ping" });
    const [forwarded] = await extension.next(1);
    expect(forwarded.id).not.toBe("client-abc");

    extension.send({ jsonrpc: "2.0", id: forwarded.id, result: "pong" });
    const [reply] = await client.next(1);
    expect(reply.id).toBe("client-abc");
  });

  it("broadcasts notifications to every client", async () => {
    // This is how onCDPEvent reaches clients: no id, so no one to route to. Dropping these
    // instead of broadcasting is what makes goto()/waitFor* hang.
    const { extension, socketPath } = await startHost();
    const first = await connectClient(socketPath);
    const second = await connectClient(socketPath);

    extension.send({ jsonrpc: "2.0", method: "onCDPEvent", params: { method: "Page.loadEventFired" } });

    for (const client of [first, second]) {
      const [event] = await client.next(1);
      expect(event.method).toBe("onCDPEvent");
    }
  });

  it("passes client notifications through untracked", async () => {
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    client.send({ jsonrpc: "2.0", method: "heartbeat", params: {} });
    const [forwarded] = await extension.next(1);
    expect(forwarded).toEqual({ jsonrpc: "2.0", method: "heartbeat", params: {} });
  });

  it("does not choke on frames split or coalesced by the socket", async () => {
    // A socket guarantees bytes, not message boundaries: one read can hold half a frame or
    // three of them.
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    const first = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" }));
    const second = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" }));
    const joined = Buffer.concat([first, second]);
    client.socket.write(joined.subarray(0, 3));
    client.socket.write(joined.subarray(3, first.length + 2));
    client.socket.write(joined.subarray(first.length + 2));

    const forwarded = await extension.next(2);
    expect(forwarded.map((m) => m.method)).toEqual(["a", "b"]);
  });

  it("relays a payload far past Chrome's 1MB host-to-Chrome cap", async () => {
    // Screenshots travel extension → host, the direction Chrome allows up to 4GB. The 1MB
    // limit applies to host → Chrome, which only ever carries small RPC requests.
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    client.send({ jsonrpc: "2.0", id: 1, method: "executeCdp" });
    const [forwarded] = await extension.next(1);
    const screenshot = "A".repeat(4 * 1024 * 1024);
    extension.send({ jsonrpc: "2.0", id: forwarded.id, result: { data: screenshot } });

    const [reply] = await client.next(1);
    expect((reply.result as { data: string }).data).toHaveLength(screenshot.length);
  });

  it("adapts cached-expression RPCs for extensions that only expose executeCdp", async () => {
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);
    const baseParams = {
      target: { tabId: 7 },
      method: "Runtime.evaluate",
      expressionCacheKey: "playwright-bootstrap",
    };

    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "executeCdpWithCachedExpression",
      params: {
        ...baseParams,
        commandParams: { expression: "globalThis.__injected = true", returnByValue: true },
      },
    });
    const [first] = await extension.next(1);
    expect(first).toMatchObject({
      method: "executeCdp",
      params: {
        target: { tabId: 7 },
        method: "Runtime.evaluate",
        commandParams: {
          expression: "globalThis.__injected = true",
          returnByValue: true,
        },
      },
    });
    extension.send({ jsonrpc: "2.0", id: first.id, result: { value: "first" } });
    expect((await client.next(1))[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { kind: "executed", result: { value: "first" } },
    });

    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "executeCdpWithCachedExpression",
      params: { ...baseParams, commandParams: { returnByValue: true } },
    });
    const second = (await extension.next(2))[1];
    expect(second).toMatchObject({
      method: "executeCdp",
      params: {
        commandParams: {
          expression: "globalThis.__injected = true",
          returnByValue: true,
        },
      },
    });
    extension.send({ jsonrpc: "2.0", id: second.id, result: { value: "second" } });
    expect((await client.next(2))[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { kind: "executed", result: { value: "second" } },
    });

    client.send({
      jsonrpc: "2.0",
      id: 3,
      method: "executeCdpWithCachedExpression",
      params: {
        ...baseParams,
        expressionCacheKey: "unknown",
        commandParams: { returnByValue: true },
      },
    });
    expect((await client.next(3))[2]).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { kind: "cache-miss" },
    });
    expect(extension.received).toHaveLength(2);
  });

  it("drops a departed client's late reply instead of broadcasting it", async () => {
    // The reply has nowhere to go once its client is gone. Falling through to the broadcast
    // path would hand one session's response — page content and all — to every other client,
    // including one that just connected and never asked for anything.
    const { extension, socketPath, errors } = await startHost();
    const client = await connectClient(socketPath);

    client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    const [forwarded] = await extension.next(1);
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const survivor = await connectClient(socketPath);
    extension.send({ jsonrpc: "2.0", id: forwarded.id, result: "secret page content" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(survivor.received).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining("orphaned reply")]);
  });

  it("still broadcasts notifications while a reply is orphaned", async () => {
    // The drop above keys off result-vs-method, not off "unknown id" — a notification has no
    // id at all and must keep flowing.
    const { extension, socketPath } = await startHost();
    const client = await connectClient(socketPath);

    extension.send({ jsonrpc: "2.0", id: "operon:999", result: "orphan" });
    extension.send({ jsonrpc: "2.0", method: "onCDPEvent", params: {} });

    const [event] = await client.next(1);
    expect(event.method).toBe("onCDPEvent");
    expect(client.received).toHaveLength(1);
  });

  it("survives a malformed frame from a client", async () => {
    const { extension, socketPath, errors } = await startHost();
    const client = await connectClient(socketPath);

    client.socket.write(encodeFrame("{ not json"));
    client.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    const [forwarded] = await extension.next(1);
    expect(forwarded.method).toBe("ping");
    expect(errors).toHaveLength(1);
  });

  it("removes its socket file on close so the next run can bind", async () => {
    const { host, socketPath } = await startHost();
    await host.close();
    await expect(connectClient(socketPath)).rejects.toThrow();
  });

  it("shuts down when Chrome closes the pipe", async () => {
    const { extension, socketPath } = await startHost();
    let disconnected = false;
    const host = new ChromeNativeHost({
      stdin: extension.stdin,
      stdout: extension.stdout,
      socketPath: `${socketPath}.second`,
      onExtensionDisconnect: () => {
        disconnected = true;
      },
    });
    await host.listen();
    extension.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disconnected).toBe(true);
  });
});

/**
 * A socket file whose owner is gone — what SIGKILL leaves behind, and the only case the sweep
 * is allowed to act on. Renaming the path out from under a listening server and then closing it
 * gets there without spawning a process to kill: Node unlinks the name it bound, which no longer
 * exists, and the renamed file is left with nothing listening on it.
 */
async function leakSocket(dir: string, name: string): Promise<string> {
  const bound = path.join(dir, `bound-${name}`);
  const orphan = path.join(dir, name);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(bound, resolve));
  await rename(bound, orphan);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return orphan;
}

/** A backend that is still answering. Someone else's, as far as the sweep can tell. */
async function liveSocket(dir: string, name: string): Promise<string> {
  const target = path.join(dir, name);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(target, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return target;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the sweep");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("stale socket sweep", () => {
  it("removes what nothing is listening on and leaves everything else alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "operon-native-host-sweep-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const orphan = await leakSocket(dir, "orphan.sock");
    const live = await liveSocket(dir, "live.sock");
    // The directory is shared, so it can hold things that are not ours and not sockets. Only
    // ECONNREFUSED means "nothing is bound"; anything else must survive.
    const regularFile = path.join(dir, "notes.txt");
    await writeFile(regularFile, "not a socket");

    const extension = fakeExtension();
    const host = new ChromeNativeHost({
      stdin: extension.stdin,
      stdout: extension.stdout,
      socketPath: path.join(dir, "host.sock"),
    });
    const own = await host.listen();
    cleanups.push(() => host.close());

    await waitFor(() => !existsSync(orphan));
    expect(existsSync(live)).toBe(true);
    expect(existsSync(regularFile)).toBe(true);
    expect(existsSync(own)).toBe(true);
  });
});
