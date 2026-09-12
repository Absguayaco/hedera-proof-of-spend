import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import type { DecideAndBuyResult, Decision } from "./decide-and-buy.ts";
import {
  anchorField,
  callerSuppliedCheckBudget,
  exitCodeFor,
  parseArgs,
  receiptField,
  reportHead,
  resolveMode,
} from "./buy.ts";

describe("parseArgs", () => {
  const ENV = {} as NodeJS.ProcessEnv;

  it("parses a full caller-supplied invocation", () => {
    const args = parseArgs(
      ["espresso", "--agent", "test-agent", "--verdict", "approved", "--rule", "rule-1", "--reason", "ok"],
      ENV,
    );

    expect(args).toEqual({
      slug: "espresso",
      agent: "test-agent",
      verdict: "approved",
      ruleId: "rule-1",
      reason: "ok",
      topicId: undefined,
    });
  });

  it("leaves verdict/ruleId/reason undefined for a headless-mode invocation (no --verdict at all)", () => {
    const args = parseArgs(["espresso", "--agent", "test-agent"], ENV);

    expect(args.verdict).toBeUndefined();
    expect(args.ruleId).toBeUndefined();
    expect(args.reason).toBeUndefined();
  });

  it("throws when the slug is missing", () => {
    expect(() => parseArgs(["--agent", "test-agent"], ENV)).toThrow(/Missing the menu slug/);
  });

  it("throws when --agent is missing", () => {
    expect(() => parseArgs(["espresso"], ENV)).toThrow(/Missing --agent/);
  });

  it('throws when --verdict is not "approved" or "declined"', () => {
    expect(() =>
      parseArgs(["espresso", "--agent", "a", "--verdict", "maybe", "--rule", "r"], ENV),
    ).toThrow(/--verdict must be "approved" or "declined"/);
  });

  it("throws when --verdict is given without --rule", () => {
    expect(() => parseArgs(["espresso", "--agent", "a", "--verdict", "declined"], ENV)).toThrow(
      /--verdict was given but --rule was not/,
    );
  });

  it("accepts --rule none as an explicit, valid rule id", () => {
    const args = parseArgs(["espresso", "--agent", "a", "--verdict", "declined", "--rule", "none"], ENV);

    expect(args.ruleId).toBe("none");
  });

  it("falls back to HCS_TOPIC_ID from the environment when --topic is not given", () => {
    const args = parseArgs(["espresso", "--agent", "a"], { HCS_TOPIC_ID: "0.0.777" } as NodeJS.ProcessEnv);

    expect(args.topicId).toBe("0.0.777");
  });

  it("prefers an explicit --topic over HCS_TOPIC_ID", () => {
    const args = parseArgs(
      ["espresso", "--agent", "a", "--topic", "0.0.111"],
      { HCS_TOPIC_ID: "0.0.777" } as NodeJS.ProcessEnv,
    );

    expect(args.topicId).toBe("0.0.111");
  });
});

describe("callerSuppliedCheckBudget", () => {
  it("returns exactly the supplied verdict/rule/reason, ignoring its own request argument", async () => {
    const checkBudget = callerSuppliedCheckBudget("declined", "rule-1", "over budget");

    const response = await checkBudget({ agent: "irrelevant", resource: "https://example.test/buy/anything" });

    expect(response).toEqual({ verdict: "declined", budgetRuleId: "rule-1", reason: "over budget" });
  });

  it("carries reason through as undefined when none was supplied", async () => {
    const checkBudget = callerSuppliedCheckBudget("approved", "none", undefined);

    const response = await checkBudget({ agent: "a", resource: "r" });

    expect(response).toEqual({ verdict: "approved", budgetRuleId: "none", reason: undefined });
  });
});

describe("resolveMode", () => {
  it("throws (refuses to buy) when neither an agent key nor a verdict is available", () => {
    expect(() => resolveMode(undefined, undefined)).toThrow(/Refusing to buy/);
  });

  it("resolves to headless whenever an agent key is present, regardless of verdict", () => {
    expect(resolveMode("key", undefined)).toBe("headless");
    expect(resolveMode("key", "approved")).toBe("headless");
    expect(resolveMode("key", "declined")).toBe("headless");
  });

  it("resolves to caller-supplied when a verdict is present and no agent key is", () => {
    expect(resolveMode(undefined, "approved")).toBe("caller-supplied");
    expect(resolveMode(undefined, "declined")).toBe("caller-supplied");
  });
});

describe("exitCodeFor", () => {
  it("is 1 for anchor_failed, regardless of filed", () => {
    expect(exitCodeFor("anchor_failed", false)).toBe(1);
    expect(exitCodeFor("anchor_failed", true)).toBe(1);
  });

  it("is 0 for declined, regardless of filed (nothing settled, so nothing to file)", () => {
    expect(exitCodeFor("declined", false)).toBe(0);
    expect(exitCodeFor("declined", true)).toBe(0);
  });

  it("is 0 for an approved purchase whose receipt was filed", () => {
    expect(exitCodeFor("approved", true)).toBe(0);
  });

  it("is 2 for an approved purchase whose receipt was NOT filed -- incomplete, not failed", () => {
    expect(exitCodeFor("approved", false)).toBe(2);
  });
});

// The report format is a contract, not a cosmetic choice:
// .claude/skills/anchor-before-pay/SKILL.md tells the agent to report "one
// headline and all four fields ... Nothing may be left out". These tests are
// what stop a future edit from silently dropping a field, reordering them,
// or letting the decline and purchase paths drift apart -- the doc alone
// cannot enforce any of that.

const DECISION: Decision = {
  agent: "kestrel",
  resource: "https://store.example/buy/espresso",
  verdict: "approved",
  amount: "15000000",
  currency: "HBAR",
  payTo: "0.0.54321",
  budgetRuleId: "rule-1",
  nonce: "11111111-1111-1111-1111-111111111111",
  decidedAt: "2026-09-10T00:00:00.000Z",
};

const ANCHOR: AnchorResult = {
  ok: true,
  hash: "4e4e85d0c0ffee11deadbeef22334455",
  topicId: "0.0.777",
  sequenceNumber: "2",
};

const SETTLEMENT = {
  transactionId: "0.0.12345@1757462260.774000000",
  feePayer: "0.0.12345",
  validStartSeconds: 1757462260,
  validStartNanos: 774000000,
};

describe("anchorField", () => {
  it("renders topic, sequence number and a 16-character hash prefix", () => {
    expect(anchorField(ANCHOR)).toBe("topic 0.0.777 seq #2 · hash 4e4e85d0c0ffee11…");
  });

  it("truncates to exactly 16 hash characters, however long the hash is", () => {
    const rendered = anchorField({ ...ANCHOR, hash: "a".repeat(64) });
    expect(rendered).toBe(`topic 0.0.777 seq #2 · hash ${"a".repeat(16)}…`);
  });

  // A failed anchor carries neither -- the field must still render rather
  // than print "undefined" at an operator who is trying to read the record.
  it("says unknown rather than undefined when there is no topicId", () => {
    expect(anchorField({ ok: false, hash: "deadbeefdeadbeef00", topicId: undefined })).toBe(
      "topic unknown seq ? · hash deadbeefdeadbeef…",
    );
  });
});

describe("reportHead", () => {
  it("leads with a headline, a blank line, then budget/anchor/payment for a purchase", () => {
    const result: DecideAndBuyResult = {
      outcome: "purchased",
      decision: DECISION,
      anchor: ANCHOR,
      purchase: { body: {}, amountTinybar: 15000000n, settlement: SETTLEMENT },
    };

    expect(reportHead("espresso", result)).toEqual([
      "espresso bought — 0.15 HBAR, within budget",
      "",
      "budget      approved · rule rule-1",
      "anchor      topic 0.0.777 seq #2 · hash 4e4e85d0c0ffee11…",
      "payment     0.0.12345@1757462260.774000000 · " +
        "https://hashscan.io/testnet/transaction/0.0.12345-1757462260-774000000",
    ]);
  });

  it("names the refusal's own reason in the headline, and moves nothing", () => {
    const result: DecideAndBuyResult = {
      outcome: "declined",
      decision: {
        ...DECISION,
        verdict: "declined",
        budgetRuleId: "k17d2ptn",
        reason: "0.30 would exceed the 0.20 HBAR daily limit",
      },
      anchor: ANCHOR,
    };

    expect(reportHead("espresso", result)).toEqual([
      "espresso refused — 0.30 would exceed the 0.20 HBAR daily limit",
      "",
      "budget      declined · rule k17d2ptn",
      "anchor      topic 0.0.777 seq #2 · hash 4e4e85d0c0ffee11…",
      "payment     none — nothing moved",
    ]);
  });

  it("falls back to a generic headline when the checker gave no reason", () => {
    const result: DecideAndBuyResult = {
      outcome: "declined",
      decision: { ...DECISION, verdict: "declined" },
      anchor: ANCHOR,
    };
    expect(reportHead("espresso", result)[0]).toBe("espresso refused — the budget declined it");
  });

  it("reports a failed anchor as a failure, with no payment", () => {
    const result: DecideAndBuyResult = {
      outcome: "anchor_failed",
      decision: DECISION,
      anchor: { ok: false, hash: "4e4e85d0c0ffee11deadbeef22334455" },
      message: "Refusing to buy: decision could not be confirmed at HCS consensus.",
    };

    expect(reportHead("espresso", result)).toEqual([
      "espresso not bought — the decision could not be confirmed at consensus",
      "",
      "budget      approved · rule rule-1",
      "anchor      failed — Refusing to buy: decision could not be confirmed at HCS consensus.",
      "payment     none — nothing moved",
    ]);
  });

  // The whole point of the format: four labelled fields, always, in one
  // fixed order, whatever happened.
  it.each(["anchor_failed", "declined", "purchased"] as const)(
    "always emits a headline, a blank line, then budget/anchor/payment (%s)",
    (outcome) => {
      const result = {
        outcome,
        decision: DECISION,
        anchor: ANCHOR,
        message: "nope",
        purchase: { body: {}, amountTinybar: 15000000n, settlement: SETTLEMENT },
      } as DecideAndBuyResult;

      const lines = reportHead("espresso", result);
      expect(lines).toHaveLength(5);
      expect(lines[1]).toBe("");
      expect(lines[2]?.startsWith("budget      ")).toBe(true);
      expect(lines[3]?.startsWith("anchor      ")).toBe(true);
      expect(lines[4]?.startsWith("payment     ")).toBe(true);
    },
  );
});

describe("receiptField", () => {
  it("has nothing to file when the anchor failed", () => {
    expect(receiptField("anchor_failed", "caller-supplied", false)).toBe(
      "receipt     none — nothing to file",
    );
  });

  it("says a refusal files nothing, because the anchor is already the record", () => {
    expect(receiptField("declined", "headless", false)).toBe(
      "receipt     none — a refusal files nothing; the anchor is the record",
    );
  });

  it("is filed once a headless run has filed it", () => {
    expect(receiptField("purchased", "headless", true)).toBe("receipt     filed");
  });

  // Both unfiled cases must be loud: a spend the ledger cannot see is a
  // spend the next budget check cannot subtract, which is exactly when a
  // cap stops binding. Never blank, never omitted.
  it.each([
    ["headless", "filing failed"],
    ["caller-supplied", "file this to askReceipts yourself"],
  ] as const)("shouts NOT FILED, and says whose job it is (%s)", (mode, expected) => {
    const rendered = receiptField("purchased", mode, false);
    expect(rendered.startsWith("receipt     NOT FILED — ")).toBe(true);
    expect(rendered).toContain(expected);
  });
});
