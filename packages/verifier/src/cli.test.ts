import { describe, expect, it } from "vitest";
import { extractDecisionReference, resolveTopicId } from "./cli.ts";

describe("resolveTopicId", () => {
  it("prefers an explicit topic id over anything the receipt claims", () => {
    const receipt = { decision: { topicId: "0.0.999" } };
    expect(resolveTopicId("0.0.111", receipt)).toBe("0.0.111");
  });

  it("falls back to the receipt's decision.topicId reference when no explicit topic id is given", () => {
    const receipt = { decision: { nonce: "n", topicId: "0.0.777", sequenceNumber: "1" } };
    expect(resolveTopicId(undefined, receipt)).toBe("0.0.777");
  });

  it("throws, naming what's missing, when there is no explicit topic id and the receipt has none either", () => {
    expect(() => resolveTopicId(undefined, { rail: "hedera" })).toThrow(/No topic id/);
  });

  it("throws on a receipt that is not an object", () => {
    expect(() => resolveTopicId(undefined, "not an object")).toThrow(/No topic id/);
    expect(() => resolveTopicId(undefined, null)).toThrow(/No topic id/);
  });

  it("throws when decision.topicId is present but not a non-empty string", () => {
    expect(() => resolveTopicId(undefined, { decision: { topicId: "" } })).toThrow(/No topic id/);
    expect(() => resolveTopicId(undefined, { decision: { topicId: 12345 } })).toThrow(/No topic id/);
    expect(() => resolveTopicId(undefined, { decision: null })).toThrow(/No topic id/);
    expect(() => resolveTopicId(undefined, { notDecision: {} })).toThrow(/No topic id/);
  });
});

describe("extractDecisionReference", () => {
  const VALID_RECEIPT = {
    rail: "hedera",
    authorizingDecision: { agent: "a", resource: "r", verdict: "approved", nonce: "n" },
    decision: { nonce: "n", topicId: "0.0.777", sequenceNumber: "1" },
    settlement: { transactionId: "0.0.99999@1700000000.123456789" },
  };

  it("extracts all four fields from a fully-bound receipt", () => {
    const reference = extractDecisionReference(VALID_RECEIPT);

    expect(reference).toEqual({
      authorizingDecision: VALID_RECEIPT.authorizingDecision,
      topicId: "0.0.777",
      sequenceNumber: "1",
      settlementTransactionId: "0.0.99999@1700000000.123456789",
    });
  });

  it("returns undefined, not a throw, for a receipt with no authorizingDecision", () => {
    const { authorizingDecision, ...rest } = VALID_RECEIPT;
    void authorizingDecision;
    expect(extractDecisionReference(rest)).toBeUndefined();
  });

  it("returns undefined for a receipt whose decision reference is missing topicId or sequenceNumber", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, decision: { nonce: "n" } }),
    ).toBeUndefined();
  });

  it("returns undefined for a receipt with no settlement.transactionId", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, settlement: {} }),
    ).toBeUndefined();
  });

  it("returns undefined for a non-object receipt", () => {
    expect(extractDecisionReference("not an object")).toBeUndefined();
    expect(extractDecisionReference(null)).toBeUndefined();
  });
});
