import fs from "node:fs";
import type { Writable } from "node:stream";
import { ChromeNativeHost } from "./ChromeNativeHost.ts";

/**
 * Entry point for `operon --chrome-native-host`, the process Chrome spawns.
 *
 * ## stdout is the protocol pipe
 *
 * Chrome talks to a native host over the process's own stdin/stdout. Anything else written
 * to stdout — a stray console.log, an Electron startup notice, a Node deprecation warning —
 * is interpreted as frame bytes and desynchronizes the stream permanently, with no error to
 * point at. Go hosts rarely hit this because Go never writes to stdout on its own; Node and
 * Electron both do.
 *
 * So the first thing we do, before constructing anything, is take the pipe for ourselves and
 * send everything else to stderr, which Chrome captures into its own log. Diagnostics
 * survive; they just cannot reach the pipe.
 */
export async function runChromeNativeHost(): Promise<void> {
  const pipe = takeStdout();

  const host = new ChromeNativeHost({
    stdin: process.stdin,
    stdout: pipe,
    onError: (error) => console.error(`[operon-native-host] ${error.message}`),
    onExtensionDisconnect: () => {
      // Chrome closed the pipe: the extension is gone and will respawn us on demand.
      process.exit(0);
    },
  });

  const socketPath = await host.listen();
  console.error(`[operon-native-host] listening on ${socketPath}`);

  const shutdown = () => {
    void host.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Open a private stream over fd 1 and make every other route to it lead to stderr instead.
 *
 * Returning `process.stdout` itself would leave the pipe reachable by anything that writes
 * there. So we open a second stream on the same fd, keep it to ourselves, and redirect
 * `process.stdout.write` — the funnel every console method and most libraries go through —
 * to stderr. Chrome captures stderr into its own log, so diagnostics survive; they just
 * cannot corrupt the frame stream.
 */
export function takeStdout(): Writable {
  // autoClose:false — closing this stream must not close the fd Chrome handed us.
  const pipe = fs.createWriteStream("", { fd: 1, autoClose: false });
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) =>
    typeof encoding === "function"
      ? process.stderr.write(chunk, encoding)
      : process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
  return pipe;
}
