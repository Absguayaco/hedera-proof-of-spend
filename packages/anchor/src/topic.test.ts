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

function mirrorTopicResponse(
  submitKey: { _type: string; key: unknown } | null,
  overrides: { adminKey?: unknown } = {},
): Response {
  return new Response(
    JSON.stringify({
      topic_id: "0.0.777",
      submit_key: submitKey,
      admin_key: overrides.adminKey ?? null,
    }),
    { status: 200 },
  );
}

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
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
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).resolves.toBeUndefined();
  });

  it("requests exactly GET /api/v1/topics/{id} on the testnet mirror node, URI-encoded", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return mirrorTopicResponse({
        _type: "ECDSA_SECP256K1",
        key: OPERATOR_KEY.publicKey.toStringRaw(),
      });
    }) as typeof fetch;

    await assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([]));

    expect(requested).toEqual(["https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.777"]);
  });

  it("is case-insensitive when comparing the mirror node's hex key to toStringRaw()", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse({
        _type: "ECDSA_SECP256K1",
        key: OPERATOR_KEY.publicKey.toStringRaw().toUpperCase(),
      })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).resolves.toBeUndefined();
  });

  it("throws, naming the topic, when the topic has no submit key at all", async () => {
    const fetchImpl = (async () => mirrorTopicResponse(null)) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/0\.0\.777/);
    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
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
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/does not (control|own|match)/);
  });

  it("throws, mentioning the admin key, when the topic has one -- its submit key could be changed or cleared later", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse(
        { _type: "ECDSA_SECP256K1", key: OPERATOR_KEY.publicKey.toStringRaw() },
        { adminKey: { _type: "ED25519", key: "a".repeat(64) } },
      )) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/admin key/);
  });

  it("throws, without decoding it, when the submit key is a multi-key (KeyList/ThresholdKey) structure", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse({ _type: "ProtobufEncoded", key: "deadbeef" })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/multi-key|KeyList|ThresholdKey/);
  });

  it("throws, rather than crashing, when submit_key.key is not a string", async () => {
    const fetchImpl = (async () =>
      mirrorTopicResponse({ _type: "ECDSA_SECP256K1", key: 12345 })) as typeof fetch;

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/unexpected shape/);
  });

  it("retries a 404 (mirror-node ingestion lag on a just-created topic), succeeding once it appears", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 3
        ? new Response(null, { status: 404 })
        : mirrorTopicResponse({
            _type: "ECDSA_SECP256K1",
            key: OPERATOR_KEY.publicKey.toStringRaw(),
          });
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep(sleepCalls)),
    ).resolves.toBeUndefined();

    expect(call).toBe(3);
    expect(sleepCalls).toEqual([5_000, 5_000]);
  });

  it("gives up after 6 attempts of a persistent 404, naming the topic", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep(sleepCalls)),
    ).rejects.toThrow(/0\.0\.777/);
    expect(call).toBe(6);
    expect(sleepCalls).toHaveLength(5);
  });

  it("throws immediately, without retrying, when the mirror node returns a non-404 non-2xx status", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    await expect(
      assertTopicOwnership("0.0.777", OPERATOR_KEY.publicKey, fetchImpl, fakeSleep(sleepCalls)),
    ).rejects.toThrow(/500/);
    expect(call).toBe(1);
    expect(sleepCalls).toHaveLength(0);
  });
});
