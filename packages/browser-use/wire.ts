import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";

/**
 * The Operon Browser Use wire layer: length-prefixed JSON frames.
 *
 * A frame is a 4-byte uint32 length in *native* byte order, followed by UTF-8
 * JSON. The length is written and read with `os.endianness()`, not fixed to
 * little-endian.
 *
 * Computer Use's native pipe uses the same framing; being macOS-only it can
 * hardcode `readUInt32LE`, since macOS is always little-endian.
 */

/** Header size in bytes. */
export const FRAME_HEADER_BYTES = 4;

/** Chosen by `os.endianness()`; this is not fixed little-endian. */
const isLittleEndian = () => os.endianness() === "LE";

export function encodeFrame(json: string): Buffer {
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  if (isLittleEndian()) frame.writeUInt32LE(payload.length, 0);
  else frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export interface DecodedFrames {
  messages: string[];
  /** The incomplete tail; the caller joins it with the next chunk before parsing. */
  remainingData: Buffer;
}

/**
 * Parse every complete frame out of an accumulated buffer.
 * Neither TCP nor a unix socket preserves message boundaries: one `data` event
 * can carry half a frame or several, which is why the caller has to hold on to
 * remainingData.
 */
export function decodeFrames(buffer: Buffer): DecodedFrames {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= FRAME_HEADER_BYTES) {
    const length = isLittleEndian() ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const total = FRAME_HEADER_BYTES + length;
    if (buffer.length - offset < total) break; // Partial frame; wait for more.
    messages.push(buffer.subarray(offset + FRAME_HEADER_BYTES, offset + total).toString("utf8"));
    offset += total;
  }
  return { messages, remainingData: buffer.subarray(offset) };
}

/**
 * The directory backend sockets live in, rather than any fixed socket file.
 *
 * The IAB backend and the Chrome extension share this private directory and are
 * told apart by `getInfo().type`. A client reads the directory, connects to each
 * candidate socket in turn, and completes discovery through `getInfo()`.
 */
export function backendSocketDir(platform: string = process.platform): string {
  return platform === "win32" ? "\\\\.\\pipe\\operon-browser-use" : "/tmp/operon-browser-use";
}

/** This backend's own socket path; `id` has to be unique within the directory. */
export function backendSocketPath(id: string, platform: string = process.platform): string {
  const dir = backendSocketDir(platform);
  return platform === "win32" ? `${dir}-${id}` : path.join(dir, `${id}.sock`);
}

/**
 * The IAB backend's runtime identity. Clients use it to filter IAB backends only;
 * the Chrome extension takes no part.
 *
 * Production uses `operon` throughout. Tests override it to isolate their own IAB
 * instances inside the shared discovery directory.
 */
export const OPERON_BUILD_FLAVOR = "operon";

/** Env var a client reads for the IAB flavour it expects; the kernel should set it
 *  to `OPERON_BUILD_FLAVOR`. */
export const BUILD_FLAVOR_ENV = "OPERON_BROWSER_USE_BUILD_FLAVOR";

/** One capability in `getInfo()`: `{id: string, description: string}`. */
export interface BrowserCapability {
  id: string;
  description: string;
}

/**
 * The `getInfo()` response. The authoritative schema:
 *
 *   br = l.object({
 *     apiSupportOverrides: l.record(l.boolean()).optional(),
 *     capabilities: eF,                       // {browser?: Cap[], tab?: Cap[]}
 *     id: l.string(),
 *     name: l.string(),
 *     type: l.enum(["iab","extension","cdp"]),
 *     metadata: l.record(l.string()).optional(),
 *   })
 */
export interface BrowserInfo {
  id: string;
  name: string;
  type: "iab" | "extension" | "cdp";
  capabilities: {
    browser?: BrowserCapability[];
    tab?: BrowserCapability[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  /**
   * A record of strings: the values must be strings.
   * IAB session ownership lives here, and a client selects a backend by testing
   * `info.metadata?.operonSessionId` against the current session.
   */
  metadata?: Record<string, string>;
}
