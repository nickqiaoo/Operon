import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import os from "node:os";
import {
  FRAME_HEADER_BYTES,
  encodeFrame,
  decodeFrames,
  backendSocketDir,
  backendSocketPath,
} from "./wire.ts";

/**
 * Wire contract tests. These assert the byte format itself rather than our
 * implementation details: a 4-byte native-endian uint32 length followed by UTF-8
 * JSON.
 */

const readLen = (b: Buffer) => (os.endianness() === "LE" ? b.readUInt32LE(0) : b.readUInt32BE(0));

describe("framing", () => {
  it("the header is the payload byte length as a 4-byte native-endian uint32", () => {
    const frame = encodeFrame('{"a":1}');
    expect(FRAME_HEADER_BYTES).toBe(4);
    expect(frame.length).toBe(4 + 7);
    expect(readLen(frame)).toBe(7);
    expect(frame.subarray(4).toString("utf8")).toBe('{"a":1}');
  });

  it("the length counts UTF-8 bytes, not characters", () => {
    // The classic bug: str.length counts a CJK character as 1 while it occupies 3
    // bytes, which misaligns the frame and ruins the whole stream.
    const json = '{"t":"中文"}';
    const frame = encodeFrame(json);
    expect(readLen(frame)).toBe(Buffer.byteLength(json, "utf8"));
    expect(readLen(frame)).not.toBe(json.length);
    expect(decodeFrames(frame).messages).toEqual([json]);
  });

  it("round-trip", () => {
    const { messages, remainingData } = decodeFrames(encodeFrame('{"hello":"world"}'));
    expect(messages).toEqual(['{"hello":"world"}']);
    expect(remainingData.length).toBe(0);
  });

  it("every frame in one buffer is parsed out", () => {
    const buf = Buffer.concat([encodeFrame('{"n":1}'), encodeFrame('{"n":2}'), encodeFrame('{"n":3}')]);
    const { messages, remainingData } = decodeFrames(buf);
    expect(messages).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(remainingData.length).toBe(0);
  });

  it("a partial frame stays in remainingData until a later chunk completes it, since sockets do not preserve message boundaries", () => {
    const full = Buffer.concat([encodeFrame('{"n":1}'), encodeFrame('{"n":2}')]);
    const cut = 4 + 7 + 3; // A complete first frame plus 3 bytes of the second.
    const first = decodeFrames(full.subarray(0, cut));
    expect(first.messages).toEqual(['{"n":1}']);
    expect(first.remainingData.length).toBe(3);

    const second = decodeFrames(Buffer.concat([first.remainingData, full.subarray(cut)]));
    expect(second.messages).toEqual(['{"n":2}']);
    expect(second.remainingData.length).toBe(0);
  });

  it("a header with no payload yet yields no message and stays entirely in remaining", () => {
    const frame = encodeFrame('{"n":1}');
    const { messages, remainingData } = decodeFrames(frame.subarray(0, 4));
    expect(messages).toEqual([]);
    expect(remainingData.length).toBe(4);
  });

  it("less than a full header is kept as-is", () => {
    const { messages, remainingData } = decodeFrames(Buffer.from([0x01, 0x02]));
    expect(messages).toEqual([]);
    expect(remainingData.length).toBe(2);
  });

  it("a frame with an empty payload", () => {
    const frame = encodeFrame("");
    expect(readLen(frame)).toBe(0);
    expect(decodeFrames(frame).messages).toEqual([""]);
  });
});

describe("tabId constraints", () => {
  // Both sides constrain this. The backend rejects a tabId that is not an
  // integer, and the client accepts a string but only one that converts to a
  // positive integer. So a string on the wire is fine, provided it parses as a
  // positive integer. Operon's own base36 instanceId yields NaN.
  const isValidWireTabId = (id: string) => {
    const n = Number(id);
    return Number.isInteger(n) && n > 0;
  };

  it("a numeric string like webContents.id is valid", () => {
    expect(isValidWireTabId("1")).toBe(true);
    expect(isValidWireTabId("42")).toBe(true);
  });

  it("operon's base36 instanceId is not valid: the driver has to use webContents.id", () => {
    expect(isValidWireTabId("4gjf9p")).toBe(false);
    expect(isValidWireTabId("h14rzhvt")).toBe(false);
  });

  it("zero, negatives, fractions and the empty string are all invalid", () => {
    for (const bad of ["0", "-1", "1.5", "", "abc"]) {
      expect(isValidWireTabId(bad), `${bad} should be invalid`).toBe(false);
    }
  });
});

describe("socket paths", () => {
  it("posix: uses Operon's private directory, with IAB and the extension told apart by getInfo().type", () => {
    expect(backendSocketDir("darwin")).toBe("/tmp/operon-browser-use");
    expect(backendSocketDir("linux")).toBe("/tmp/operon-browser-use");
    expect(backendSocketPath("abc123", "darwin")).toBe("/tmp/operon-browser-use/abc123.sock");
  });

  it("win32: the named pipe prefix", () => {
    expect(backendSocketDir("win32")).toBe("\\\\.\\pipe\\operon-browser-use");
    expect(backendSocketPath("abc123", "win32")).toBe("\\\\.\\pipe\\operon-browser-use-abc123");
  });

  it("there is no dedicated -iab.sock path", () => {
    expect(backendSocketDir("darwin")).not.toContain("iab");
    expect(backendSocketPath("x", "darwin")).not.toContain("iab");
  });
});
