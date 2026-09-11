import { describe, expect, it } from "vitest";
import { classifyRun, extractDecisionReference, resolveTopicId } from "./cli.ts";

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

  it("returns undefined, not a throw, for a receipt with no authorizingDecision key at all", () => {
    const { authorizingDecision, ...rest } = VALID_RECEIPT;
    void authorizingDecision;
    expect(extractDecisionReference(rest)).toBeUndefined();
  });

  it("returns undefined for a receipt whose authorizingDecision is explicitly null or undefined", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, authorizingDecision: null }),
    ).toBeUndefined();
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, authorizingDecision: undefined }),
    ).toBeUndefined();
  });

  it("returns undefined when decision.topicId alone is missing", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, decision: { nonce: "n", sequenceNumber: "1" } }),
    ).toBeUndefined();
  });

  it("returns undefined when decision.sequenceNumber alone is missing", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, decision: { nonce: "n", topicId: "0.0.777" } }),
    ).toBeUndefined();
  });

  it("returns undefined when decision.topicId is present but not a string", () => {
    expect(
      extractDecisionReference({
        ...VALID_RECEIPT,
        decision: { nonce: "n", topicId: 777, sequenceNumber: "1" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when decision.sequenceNumber is present but not a string", () => {
    expect(
      extractDecisionReference({
        ...VALID_RECEIPT,
        decision: { nonce: "n", topicId: "0.0.777", sequenceNumber: 1 },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when decision itself is null or not an object", () => {
    expect(extractDecisionReference({ ...VALID_RECEIPT, decision: null })).toBeUndefined();
    expect(extractDecisionReference({ ...VALID_RECEIPT, decision: "0.0.777" })).toBeUndefined();
  });

  it("returns undefined for a receipt with no settlement.transactionId", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, settlement: {} }),
    ).toBeUndefined();
  });

  it("returns undefined when settlement.transactionId is present but not a string", () => {
    expect(
      extractDecisionReference({ ...VALID_RECEIPT, settlement: { transactionId: 123 } }),
    ).toBeUndefined();
  });

  it("returns undefined when settlement itself is null or not an object", () => {
    expect(extractDecisionReference({ ...VALID_RECEIPT, settlement: null })).toBeUndefined();
    expect(extractDecisionReference({ ...VALID_RECEIPT, settlement: "paid" })).toBeUndefined();
  });

  it("returns undefined for a non-object receipt", () => {
    expect(extractDecisionReference("not an object")).toBeUndefined();
    expect(extractDecisionReference(null)).toBeUndefined();
  });
});

describe("classifyRun", () => {
  it("passes on an old-format receipt with no ordering reference, hash alone matching", () => {
    expect(classifyRun("match", false, undefined, undefined)).toBe(true);
  });

  it("fails when the receipt's own hash did not match, even with no reference", () => {
    expect(classifyRun("missing", false, undefined, undefined)).toBe(false);
    expect(classifyRun("altered", false, undefined, undefined)).toBe(false);
  });

  it("fails when a reference is present but the decision anchor did not match (altered decision)", () => {
    expect(classifyRun("match", true, "altered", "decision_before_settlement")).toBe(false);
  });

  it("fails when a reference is present but ordering was violated", () => {
    expect(classifyRun("match", true, "match", "decision_not_before_settlement")).toBe(false);
  });

  it("passes only when hash matches, decision matches, and ordering holds", () => {
    expect(classifyRun("match", true, "match", "decision_before_settlement")).toBe(true);
  });
});
