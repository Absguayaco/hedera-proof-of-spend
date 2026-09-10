import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { HASH_VERSION } from "./hash.ts";
import { assertTopicOwnership, encodeAnchorMessage } from "./topic.ts";

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

function mirrorTopicResponse(submitKey: { _type: string; key: string } | null): Response {
  return new Response(JSON.stringify({ topic_id: "0.0.777", submit_key: submitKey }), {
    status: 200,
  });
}

describe("assertTopicOwnership", () => {
  const OPERATOR_KEY = PrivateKey.generateECDSA();

  it("resolves silently when the topic's submit key matches the operator's own key", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse({
        _type: "ECDSA_SECP256K1",
        key: OPERATOR_KEY.publicKey.toStringRaw(),
      })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("is case-insensitive when comparing the mirror node's hex key to toStringRaw()", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse({
        _type: "ECDSA_SECP256K1",
        key: OPERATOR_KEY.publicKey.toStringRaw().toUpperCase(),
      })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("throws, naming the topic, when the topic has no submit key at all", async () => {
    const fetchImpl = (async () => mirrorTopicResponse(null)) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).rejects.toThrow(/0\.0\.777/);
    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).rejects.toThrow(/no submit key/);
  });

  it("throws when the topic's submit key belongs to a different key", async () => {
    const someoneElse = PrivateKey.generateECDSA();
    const fetchImpl = (async () =>
      mirrorTopicResponse({
        _type: "ECDSA_SECP256K1",
        key: someoneElse.publicKey.toStringRaw(),
      })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).rejects.toThrow(/does not (control|own|match)/);
  });

  it("throws, without leaking to a generic parse error, when the mirror node returns a non-2xx status", async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl),
    ).rejects.toThrow(/404/);
  });
});
