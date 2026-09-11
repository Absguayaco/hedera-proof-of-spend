import type { Client, PublicKey } from "@hiero-ledger/sdk";
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { anchorReceipt } from "./index.ts";
import type { SubmitHashResult } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const RECEIPT = { rail: "hedera", amount: "15000000" };

function fakeHcs(
  overrides: Partial<{
    createTopic: (client: Client, submitKey: PublicKey) => Promise<string>;
    submitHash: (client: Client, topicId: string, hash: string) => Promise<SubmitHashResult>;
    assertTopicOwnership: (topicId: string, operatorPublicKey: PublicKey) => Promise<void>;
  }> = {},
) {
  return {
    createTopic: overrides.createTopic ?? (async () => "0.0.777"),
    submitHash: overrides.submitHash ?? (async () => ({ sequenceNumber: "1" })),
    assertTopicOwnership: overrides.assertTopicOwnership ?? (async () => undefined),
  };
}

describe("anchorReceipt", () => {
  it("creates a topic and submits the hash when no topicId is given", async () => {
    const submitted: Array<{ topicId: string; hash: string }> = [];
    const hcs = fakeHcs({
      submitHash: async (_client, topicId, hash) => {
        submitted.push({ topicId, hash });
        return { sequenceNumber: "1" };
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({
      ok: true,
      hash: hashReceipt(RECEIPT),
      topicId: "0.0.777",
      sequenceNumber: "1",
    });
    expect(submitted).toEqual([{ topicId: "0.0.777", hash: hashReceipt(RECEIPT) }]);
  });

  it("reports the topic sequence number the HCS submission returned, converted to a decimal string", async () => {
    const hcs = fakeHcs({ submitHash: async () => ({ sequenceNumber: "42" }) });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(result.sequenceNumber).toBe("42");
  });

  it("reuses a given topicId and never calls createTopic, but DOES verify ownership first", async () => {
    let createCalled = false;
    const ownershipChecks: Array<{ topicId: string }> = [];
    const hcs = fakeHcs({
      createTopic: async () => {
        createCalled = true;
        return "0.0.999";
      },
      assertTopicOwnership: async (topicId) => {
        ownershipChecks.push({ topicId });
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY, topicId: "0.0.123" },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(result.topicId).toBe("0.0.123");
    expect(result.sequenceNumber).toBe("1");
    expect(createCalled).toBe(false);
    expect(ownershipChecks).toEqual([{ topicId: "0.0.123" }]);
  });

  it("never throws: an ownership-check failure on a reused topic becomes {ok:false, topicId, error}, and never submits", async () => {
    let submitCalled = false;
    const hcs = fakeHcs({
      assertTopicOwnership: async () => {
        throw new Error("its submit key does not match this operator's key");
      },
      submitHash: async () => {
        submitCalled = true;
        return { sequenceNumber: "1" };
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY, topicId: "0.0.123" },
      hcs,
    );

    expect(result).toEqual({
      ok: false,
      hash: hashReceipt(RECEIPT),
      topicId: "0.0.123",
      error: expect.stringMatching(/does not match this operator's key/),
    });
    expect(submitCalled).toBe(false);
  });

  it("does NOT verify ownership when creating a fresh topic -- a topic this same call just created is trivially self-owned", async () => {
    let ownershipCheckCalled = false;
    const hcs = fakeHcs({
      assertTopicOwnership: async () => {
        ownershipCheckCalled = true;
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(ownershipCheckCalled).toBe(false);
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
    expect(result.sequenceNumber).toBeUndefined();
  });

  it("reports the newly created topicId when submitHash fails, so a retry can reuse it", async () => {
    const hcs = fakeHcs({
      createTopic: async () => "0.0.777",
      submitHash: async () => {
        throw new Error("mirror node unreachable");
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({
      ok: false,
      hash: hashReceipt(RECEIPT),
      topicId: "0.0.777",
      error: expect.stringMatching(/mirror node unreachable/),
    });
  });

  it("never throws: an invalid operator key becomes {ok:false, error}", async () => {
    const INVALID_KEY = "not-a-key";
    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: INVALID_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(INVALID_KEY);
    expect(result.error).not.toContain(OPERATOR_KEY);
  });

  it("never throws: an invalid operator id becomes {ok:false, error}, not a rejected promise", async () => {
    await expect(
      anchorReceipt(
        RECEIPT,
        { operatorId: "not-an-account-id", operatorKey: OPERATOR_KEY },
        fakeHcs(),
      ),
    ).resolves.toMatchObject({ ok: false, hash: hashReceipt(RECEIPT) });
  });

  it("never throws: a receipt that fails canonicalization becomes {ok:false, error}, empty hash", async () => {
    const result = await anchorReceipt(
      { n: 1 },
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.hash).toBe("");
    expect(result.error).toMatch(/not canonicalizable/);
  });
});
