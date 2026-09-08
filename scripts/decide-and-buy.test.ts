import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import type { BuyResult } from "@proof-of-spend/buyer";
import type { CheckBudget, Decision } from "./decide-and-buy.ts";
import { decideAndBuy } from "./decide-and-buy.ts";

const AGENT = "agent-demo";
const RESOURCE = "http://localhost:8402/buy/espresso";

const REQUEST = {
  agent: AGENT,
  resource: RESOURCE,
  operatorId: "0.0.99999",
  // Opaque in every test below — never parsed by a real anchorReceipt/buyResource,
  // both of which are replaced with fakes, so this does not need to be a real key.
  operatorKey: "fake-operator-key",
};

function approve(overrides: Partial<Awaited<ReturnType<CheckBudget>>> = {}): CheckBudget {
  return async () => ({ verdict: "approved", budgetRuleId: "daily-cap", ...overrides });
}

function decline(reason = "over the daily cap"): CheckBudget {
  return async () => ({ verdict: "declined", budgetRuleId: "daily-cap", reason });
}

function fakeAnchor(result: AnchorResult, order: string[] = []) {
  const received: unknown[] = [];
  const impl = (async (receipt: unknown) => {
    received.push(receipt);
    order.push("anchor");
    return result;
  }) as Parameters<typeof decideAndBuy>[2];
  return { impl, received, order };
}

function fakeBuy(result: BuyResult | Error, order: string[] = []) {
  const calls: unknown[] = [];
  const impl = (async (request: unknown) => {
    calls.push(request);
    order.push("buy");
    if (result instanceof Error) throw result;
    return result;
  }) as Parameters<typeof decideAndBuy>[3];
  return { impl, calls };
}

const OK_ANCHOR: AnchorResult = { ok: true, hash: "a".repeat(64), topicId: "0.0.777" };
const FAILED_ANCHOR: AnchorResult = { ok: false, hash: "a".repeat(64), error: "mirror node unreachable" };
const PURCHASE: BuyResult = {
  body: { item: { slug: "espresso" } },
  amountTinybar: 15_000_000n,
  settlement: { transactionId: "0.0.99999@1700000000.123456789", feePayer: "0.0.11111", seconds: 1700000000, nanos: 123456789 },
};

describe("decideAndBuy", () => {
  it("refuses to buy when the decision cannot be confirmed at HCS consensus", async () => {
    const anchor = fakeAnchor(FAILED_ANCHOR);
    const buy = fakeBuy(PURCHASE);

    const result = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(result.outcome).toBe("anchor_failed");
    expect(result.anchor).toEqual(FAILED_ANCHOR);
    if (result.outcome === "anchor_failed") {
      expect(result.message).toMatch(/could not be confirmed at HCS consensus/);
      expect(result.message).toMatch(/mirror node unreachable/);
    }
    // A1: no payment settles unless the decision behind it is already anchored.
    expect(buy.calls).toHaveLength(0);
  });

  it("anchors a decline with the same call an approval would get, and buys nothing", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR, order);
    const buy = fakeBuy(PURCHASE, order);

    const result = await decideAndBuy(REQUEST, decline("over the daily cap"), anchor.impl, buy.impl);

    expect(result.outcome).toBe("declined");
    // E1: the decline really was anchored — same rigor as an approval, no
    // special-casing. Proven by asserting the anchor's own {ok:true} result
    // is present, not merely that decideAndBuy claims to have anchored it.
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("declined");
    expect(result.decision.reason).toBe("over the daily cap");
    expect(result.decision.budgetRuleId).toBe("daily-cap");
    expect(anchor.received).toHaveLength(1);
    expect((anchor.received[0] as Decision).verdict).toBe("declined");
    // E2: a decline settles nothing.
    expect(buy.calls).toHaveLength(0);
  });

  it("buys after an approved decision is genuinely anchored", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR, order);
    const buy = fakeBuy(PURCHASE, order);

    const result = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(result.outcome).toBe("purchased");
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("approved");
    if (result.outcome === "purchased") {
      expect(result.purchase).toEqual(PURCHASE);
    }
    expect(buy.calls).toHaveLength(1);
    expect(buy.calls[0]).toEqual({
      url: RESOURCE,
      operatorId: REQUEST.operatorId,
      operatorKey: REQUEST.operatorKey,
    });
    // Anchor-then-pay, not the other way around.
    expect(order).toEqual(["anchor", "buy"]);
  });

  it("generates a fresh nonce and an ISO decidedAt timestamp on every call", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(PURCHASE);

    const first = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);
    const second = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(() => new Date(first.decision.decidedAt).toISOString()).not.toThrow();
    expect(new Date(first.decision.decidedAt).toISOString()).toBe(first.decision.decidedAt);
  });

  it("decorates a purchase failure with the already-anchored decision, and preserves the cause", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(new Error("insufficient_funds"));

    const attempt = decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    await expect(attempt).rejects.toThrow(/was anchored at consensus/);
    await expect(attempt).rejects.toThrow(/insufficient_funds/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe("insufficient_funds");
    });
  });
});
