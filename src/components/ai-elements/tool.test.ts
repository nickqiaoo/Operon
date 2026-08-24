import { describe, expect, it } from "vitest";
import { normalizeToolOutputBlocks } from "./tool";

describe("normalizeToolOutputBlocks", () => {
  it("renders MCP image content instead of serializing base64 JSON", () => {
    expect(normalizeToolOutputBlocks({
      content: [
        { type: "text", text: "Current state" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
    })).toEqual([
      { kind: "text", text: "Current state" },
      { kind: "image", src: "data:image/png;base64,AA==" },
    ]);
  });

  it("renders a Browser Use response-meta screenshot", () => {
    expect(normalizeToolOutputBlocks({
      content: [{ type: "text", text: "Done" }],
      _meta: {
        "codex/toolSurface": {
          screenshot: { url: "data:image/png;base64,AQ==" },
        },
      },
    })).toEqual([
      { kind: "text", text: "Done" },
      { kind: "image", src: "data:image/png;base64,AQ==" },
    ]);
  });

  it("leaves ordinary JSON arrays to the existing JSON renderer", () => {
    expect(normalizeToolOutputBlocks([{ id: 1 }, { id: 2 }])).toBeUndefined();
  });
});
