import type { Client } from "@hiero-ledger/sdk";
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { anchorReceipt } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const RECEIPT = { rail: "hedera", amount: "15000000" };

function fakeHcs(
  overrides: Partial<{
    createTopic: (client: Client) => Promise<string>;
    submitHash: (client: Client, topicId: string, hash: string) => Promise<void>;
  }> = {},
) {
  return {
    createTopic: overrides.createTopic ?? (async () => "0.0.777"),
    submitHash: overrides.submitHash ?? (async () => {}),
  };
}

describe("anchorReceipt", () => {
  it("creates a topic and submits the hash when no topicId is given", async () => {
    const submitted: Array<{ topicId: string; hash: string }> = [];
    const hcs = fakeHcs({
      submitHash: async (_client, topicId, hash) => {
        submitted.push({ topicId, hash });
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({ ok: true, hash: hashReceipt(RECEIPT), topicId: "0.0.777" });
    expect(submitted).toEqual([{ topicId: "0.0.777", hash: hashReceipt(RECEIPT) }]);
  });

  it("reuses a given topicId and never calls createTopic", async () => {
    let createCalled = false;
    const hcs = fakeHcs({
      createTopic: async () => {
        createCalled = true;
        return "0.0.999";
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY, topicId: "0.0.123" },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(result.topicId).toBe("0.0.123");
    expect(createCalled).toBe(false);
  });

  it("never throws: a submit failure becomes {ok:false, error}, hash still reported", async () => {
    const hcs = fakeHcs({
      submitHash: async () => {
        throw new Error("mirror node unreachable");
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mirror node unreachable/);
    // An unanchored receipt is worth more than a lost one — the hash is
    // still reported even though the anchor failed.
    expect(result.hash).toBe(hashReceipt(RECEIPT));
  });

  it("never throws: an invalid operator key becomes {ok:false, error}", async () => {
    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: "not-a-key" },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("never throws: a receipt that fails canonicalization becomes {ok:false, error}, empty hash", async () => {
    const result = await anchorReceipt(
      { n: 1 }, // numbers are rejected by the canonicalization rule
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.hash).toBe("");
    expect(result.error).toMatch(/not canonicalizable/);
  });
});
