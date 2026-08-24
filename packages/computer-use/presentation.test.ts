import { describe, expect, it } from "vitest";
import { decodeComputerUsePresentationEvent } from "./presentation.ts";

describe("decodeComputerUsePresentationEvent", () => {
  it("accepts a scoped remote presentation event", () => {
    expect(decodeComputerUsePresentationEvent(JSON.stringify({
      type: "presentation",
      sessionID: "codex-session",
      turnID: "turn-1",
      hostSessionID: "chat-42",
      displayName: "System Settings",
      contextID: 4_149_345_965,
      width: 720,
      height: 450,
    }))).toEqual({
      type: "presentation",
      sessionID: "codex-session",
      turnID: "turn-1",
      hostSessionID: "chat-42",
      app: undefined,
      bundleIdentifier: undefined,
      displayName: "System Settings",
      contextID: 4_149_345_965,
      width: 720,
      height: 450,
      reason: undefined,
    });
  });

  /** The host needs this to explain an empty PiP instead of rendering nothing. */
  it("accepts a blocked session with its reason", () => {
    expect(decodeComputerUsePresentationEvent(JSON.stringify({
      type: "blocked",
      hostSessionID: "chat-42",
      displayName: "QQ",
      reason: "screen-recording",
    }))).toMatchObject({
      type: "blocked",
      hostSessionID: "chat-42",
      displayName: "QQ",
      reason: "screen-recording",
      contextID: undefined,
    });
  });

  it("rejects malformed JSON and unknown event types", () => {
    expect(decodeComputerUsePresentationEvent("{")).toBeUndefined();
    expect(decodeComputerUsePresentationEvent('{"type":"progress"}')).toBeUndefined();
  });
});
