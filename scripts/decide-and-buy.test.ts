import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import { canonicalize } from "@proof-of-spend/anchor";
import type { BuyResult } from "@proof-of-spend/buyer";
import type { CheckBudget, Decision } from "./decide-and-buy.ts";
import { decideAndBuy, linkReceiptToDecision } from "./decide-and-buy.ts";

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

function approve(
  overrides: Partial<Awaited<ReturnType<CheckBudget>>> = {},
  calls: unknown[] = [],
): CheckBudget & { calls: unknown[] } {
  const fn = (async (request: unknown) => {
    calls.push(request);
    return { verdict: "approved", budgetRuleId: "daily-cap", ...overrides };
  }) as CheckBudget & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

function decline(reason = "over the daily cap", calls: unknown[] = []): CheckBudget & { calls: unknown[] } {
  const fn = (async (request: unknown) => {
    calls.push(request);
    return { verdict: "declined", budgetRuleId: "daily-cap", reason };
  }) as CheckBudget & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

function fakeAnchor(result: AnchorResult, order: string[] = []) {
  const received: unknown[] = [];
  const opts: unknown[] = [];
  const impl = (async (receipt: unknown, anchorOpts: unknown) => {
    received.push(receipt);
    opts.push(anchorOpts);
    order.push("anchor");
    return result;
  }) as Parameters<typeof decideAndBuy>[2];
  return { impl, received, opts, order };
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
  settlement: {
    transactionId: "0.0.99999@1700000000.123456789",
    feePayer: "0.0.11111",
    validStartSeconds: 1700000000,
    validStartNanos: 123456789,
  },
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
    const budget = approve();

    const result = await decideAndBuy(REQUEST, budget, anchor.impl, buy.impl);

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
    // checkBudget is called with exactly {agent, resource} — nothing else
    // leaks in, and nothing it needs is dropped.
    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]).toEqual({ agent: REQUEST.agent, resource: REQUEST.resource });
    // Anchor-then-pay, not the other way around.
    expect(order).toEqual(["anchor", "buy"]);
  });

  it("forwards request.topicId to the anchor call unchanged", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(PURCHASE);
    const requestWithTopic = { ...REQUEST, topicId: "0.0.55555" };

    await decideAndBuy(requestWithTopic, approve(), anchor.impl, buy.impl);

    expect(anchor.opts).toHaveLength(1);
    expect((anchor.opts[0] as { topicId?: string }).topicId).toBe("0.0.55555");
  });

  it("fails closed on a verdict it doesn't recognize, rather than buying", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(PURCHASE);
    // Simulates what a real, not-yet-written, unverified MCP adapter could
    // actually hand this function — cast past the type system on purpose,
    // since CheckBudget's own response is untrusted at runtime.
    const unrecognized: CheckBudget = async () =>
      ({ verdict: "needs_approval" }) as unknown as Awaited<ReturnType<CheckBudget>>;

    const result = await decideAndBuy(REQUEST, unrecognized, anchor.impl, buy.impl);

    expect(result.outcome).toBe("declined");
    expect(buy.calls).toHaveLength(0);
  });

  it("guards the checkBudget call itself: a rejection is decorated and nothing is anchored or bought", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(PURCHASE);
    const budgetError = new Error("budget service timed out");
    const failingBudget: CheckBudget = async () => {
      throw budgetError;
    };

    const attempt = decideAndBuy(REQUEST, failingBudget, anchor.impl, buy.impl);

    await expect(attempt).rejects.toThrow(/Refusing to buy/);
    await expect(attempt).rejects.toThrow(/budget service timed out/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(budgetError);
    });
    expect(anchor.received).toHaveLength(0);
    expect(buy.calls).toHaveLength(0);
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

describe("linkReceiptToDecision", () => {
  it("adds a structured decision reference to the receipt -- B2/B3: no longer only a string in an error message", () => {
    const receipt = { rail: "hedera", amountTinybar: "15000000" };

    const linked = linkReceiptToDecision(receipt, {
      nonce: "11111111-1111-1111-1111-111111111111",
      topicId: "0.0.777",
      sequenceNumber: "42",
    });

    expect(linked).toEqual({
      rail: "hedera",
      amountTinybar: "15000000",
      decision: {
        nonce: "11111111-1111-1111-1111-111111111111",
        topicId: "0.0.777",
        sequenceNumber: "42",
      },
    });
    // Every value canonicalize() will see must be a string -- confirms the
    // linked receipt is still hashable under the hash-spec rule that
    // rejects raw JS numbers (packages/anchor/src/hash.ts, rule 2).
    expect(() => canonicalize(linked)).not.toThrow();
  });

  it("does not mutate the original receipt object", () => {
    const receipt = { rail: "hedera" };

    linkReceiptToDecision(receipt, { nonce: "n", topicId: "0.0.1", sequenceNumber: "1" });

    expect(receipt).toEqual({ rail: "hedera" });
  });
});

describe("decideAndBuy — B6 (nonce-replay enforcement, evaluated and closed by construction)", () => {
  it("two calls for the identical request -- even concurrent -- are each independently anchored and each independently attempt a purchase, proving there is no separate 'redeem this decision later' step for a replay to target", async () => {
    const anchorCalls: unknown[] = [];
    const anchorImpl = (async (decision: unknown) => {
      anchorCalls.push(decision);
      return {
        ok: true,
        hash: "a".repeat(64),
        topicId: "0.0.777",
        sequenceNumber: String(anchorCalls.length),
      } satisfies AnchorResult;
    }) as Parameters<typeof decideAndBuy>[2];

    const buyCalls: unknown[] = [];
    const buyImpl = (async (request: unknown) => {
      buyCalls.push(request);
      return PURCHASE;
    }) as Parameters<typeof decideAndBuy>[3];

    // Same REQUEST object, called twice concurrently. If decideAndBuy() held
    // any shared mutable state keyed by nonce, agent, or resource (a cache,
    // a "decision already anchored" map -- anything a replay-check would
    // need in order to exist), this would surface it: either a duplicate-
    // suppression effect (one call short-circuiting instead of anchoring) or
    // an observable race on shared state. Neither happens, because each
    // call generates its own randomUUID() nonce and performs its own
    // anchor-then-buy entirely inside one function invocation -- there is no
    // persisted "decision" a second, later call could redeem.
    const [first, second] = await Promise.all([
      decideAndBuy(REQUEST, approve(), anchorImpl, buyImpl),
      decideAndBuy(REQUEST, approve(), anchorImpl, buyImpl),
    ]);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(first.outcome).toBe("purchased");
    expect(second.outcome).toBe("purchased");
    // Two genuinely separate anchor calls, not one memoized/shared result
    // reused for both.
    expect(anchorCalls).toHaveLength(2);
    expect((anchorCalls[0] as Decision).nonce).not.toBe((anchorCalls[1] as Decision).nonce);
    // Two genuinely separate purchase attempts, not a second call
    // short-circuited by a "this decision was already redeemed" check --
    // exactly the persisted state B6 was evaluated to not need.
    expect(buyCalls).toHaveLength(2);
  });
});
