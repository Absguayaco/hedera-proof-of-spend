import { describe, expect, it } from "vitest";
import { HASH_VERSION } from "./hash.ts";
import { encodeAnchorMessage } from "./topic.ts";

describe("encodeAnchorMessage", () => {
  it("carries only the version and the hash — no receipt id, no amounts", () => {
    const hash = "a".repeat(64);
    expect(encodeAnchorMessage(hash)).toBe(`{"v":${HASH_VERSION},"h":"${hash}"}`);
  });

  it("produces valid JSON with exactly two keys", () => {
    const parsed = JSON.parse(encodeAnchorMessage("deadbeef"));
    expect(Object.keys(parsed).sort()).toEqual(["h", "v"]);
  });
});
