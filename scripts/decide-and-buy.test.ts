import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import { canonicalize } from "@proof-of-spend/anchor";
import type { BuyResult, HederaQuote } from "@proof-of-spend/buyer";
import type { CheckBudget, Decision } from "./decide-and-buy.ts";
import { decideAndBuy, linkReceiptToDecision } from "./decide-and-buy.ts";

const AGENT = "agent-demo";
const RESOURCE = "http://localhost:8402/buy/espresso";
const PAY_TO = "0.0.54321";

const REQUEST = {
  agent: AGENT,
  resource: RESOURCE,
  operatorId: "0.0.99999",
  // Opaque in every test below — never parsed by a real anchorReceipt/quote/settle,
  // all of which are replaced with fakes, so this does not need to be a real key.
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

const QUOTE: HederaQuote = {
  amountTinybar: "15000000",
  payTo: PAY_TO,
  // Opaque SDK plumbing — never read by decideAndBuy() itself, only passed
  // through to settleQuoteImpl(), so these do not need to be real.
  paymentRequired: {} as HederaQuote["paymentRequired"],
  accepted: {} as HederaQuote["accepted"],
};

function fakeQuote(result: HederaQuote | Error, order: string[] = []) {
  const calls: unknown[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    order.push("quote");
    if (result instanceof Error) throw result;
    return result;
  }) as Parameters<typeof decideAndBuy>[3];
  return { impl, calls };
}

function fakeSettle(result: BuyResult | Error, order: string[] = []) {
  const calls: unknown[] = [];
  const impl = (async (url: string, quote: HederaQuote, operatorId: string, operatorKey: string) => {
    calls.push({ url, quote, operatorId, operatorKey });
    order.push("settle");
    if (result instanceof Error) throw result;
    return result;
  }) as Parameters<typeof decideAndBuy>[4];
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
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);

    const result = await decideAndBuy(REQUEST, approve(), anchor.impl, quote.impl, settle.impl);

    expect(result.outcome).toBe("anchor_failed");
    expect(result.anchor).toEqual(FAILED_ANCHOR);
    if (result.outcome === "anchor_failed") {
      expect(result.message).toMatch(/could not be confirmed at HCS consensus/);
      expect(result.message).toMatch(/mirror node unreachable/);
    }
    // A1: no payment settles unless the decision behind it is already anchored.
    expect(settle.calls).toHaveLength(0);
  });

  it("anchors a decline with the same call an approval would get, and buys nothing -- but still quotes the store, so the decline is anchored with a real amount and payee too", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR, order);
    const quote = fakeQuote(QUOTE, order);
    const settle = fakeSettle(PURCHASE, order);

    const result = await decideAndBuy(REQUEST, decline("over the daily cap"), anchor.impl, quote.impl, settle.impl);

    expect(result.outcome).toBe("declined");
    // E1: the decline really was anchored — same rigor as an approval, no
    // special-casing. Proven by asserting the anchor's own {ok:true} result
    // is present, not merely that decideAndBuy claims to have anchored it.
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("declined");
    expect(result.decision.reason).toBe("over the daily cap");
    expect(result.decision.budgetRuleId).toBe("daily-cap");
    // B1: even a decline is anchored with the store's real amount and payee.
    expect(result.decision.amount).toBe("15000000");
    expect(result.decision.currency).toBe("HBAR");
    expect(result.decision.payTo).toBe(PAY_TO);
    expect(anchor.received).toHaveLength(1);
    expect((anchor.received[0] as Decision).verdict).toBe("declined");
    expect(quote.calls).toHaveLength(1);
    // E2: a decline settles nothing.
    expect(settle.calls).toHaveLength(0);
  });

  it("buys after an approved decision is genuinely anchored, settling against the SAME quote that was anchored", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR, order);
    const quote = fakeQuote(QUOTE, order);
    const settle = fakeSettle(PURCHASE, order);
    const budget = approve();

    const result = await decideAndBuy(REQUEST, budget, anchor.impl, quote.impl, settle.impl);

    expect(result.outcome).toBe("purchased");
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("approved");
    expect(result.decision.amount).toBe("15000000");
    expect(result.decision.currency).toBe("HBAR");
    expect(result.decision.payTo).toBe(PAY_TO);
    if (result.outcome === "purchased") {
      expect(result.purchase).toEqual(PURCHASE);
    }
    expect(settle.calls).toHaveLength(1);
    const settleCall = settle.calls[0] as { url: string; quote: HederaQuote; operatorId: string; operatorKey: string };
    expect(settleCall.url).toBe(RESOURCE);
    expect(settleCall.quote).toBe(QUOTE); // the exact same quote object, not a re-fetched one
    expect(settleCall.operatorId).toBe(REQUEST.operatorId);
    expect(settleCall.operatorKey).toBe(REQUEST.operatorKey);
    // checkBudget is called with exactly {agent, resource} — nothing else
    // leaks in, and nothing it needs is dropped.
    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]).toEqual({ agent: REQUEST.agent, resource: REQUEST.resource });
    // Budget check, then quote, then anchor, then settle.
    expect(order).toEqual(["quote", "anchor", "settle"]);
  });

  it("forwards request.topicId to the anchor call unchanged", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);
    const requestWithTopic = { ...REQUEST, topicId: "0.0.55555" };

    await decideAndBuy(requestWithTopic, approve(), anchor.impl, quote.impl, settle.impl);

    expect(anchor.opts).toHaveLength(1);
    expect((anchor.opts[0] as { topicId?: string }).topicId).toBe("0.0.55555");
  });

  it("defaults budgetRuleId to the sentinel \"none\" when no specific rule governed the decision (B1: never silently dropped from the hash)", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);
    const budgetWithNoRule = approve({ budgetRuleId: undefined });

    const result = await decideAndBuy(REQUEST, budgetWithNoRule, anchor.impl, quote.impl, settle.impl);

    expect(result.decision.budgetRuleId).toBe("none");
    // Every value canonicalize() will see must be a string, never an
    // omitted/undefined key doing double duty as "no rule" -- confirms the
    // sentinel really is present in the hashed preimage.
    expect(() => canonicalize(result.decision)).not.toThrow();
    expect(canonicalize(result.decision)).toContain('"budgetRuleId":"none"');
  });

  it("fails closed on a verdict it doesn't recognize, rather than buying", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);
    // Simulates what a real, not-yet-written, unverified MCP adapter could
    // actually hand this function — cast past the type system on purpose,
    // since CheckBudget's own response is untrusted at runtime.
    const unrecognized: CheckBudget = async () =>
      ({ verdict: "needs_approval" }) as unknown as Awaited<ReturnType<CheckBudget>>;

    const result = await decideAndBuy(REQUEST, unrecognized, anchor.impl, quote.impl, settle.impl);

    expect(result.outcome).toBe("declined");
    expect(settle.calls).toHaveLength(0);
  });

  it("guards the checkBudget call itself: a rejection is decorated and nothing is quoted, anchored, or bought", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);
    const budgetError = new Error("budget service timed out");
    const failingBudget: CheckBudget = async () => {
      throw budgetError;
    };

    const attempt = decideAndBuy(REQUEST, failingBudget, anchor.impl, quote.impl, settle.impl);

    await expect(attempt).rejects.toThrow(/Refusing to buy/);
    await expect(attempt).rejects.toThrow(/budget service timed out/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(budgetError);
    });
    expect(quote.calls).toHaveLength(0);
    expect(anchor.received).toHaveLength(0);
    expect(settle.calls).toHaveLength(0);
  });

  it("guards the quote call itself: a rejection is decorated and nothing is anchored or bought", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quoteError = new Error("store unreachable");
    const quote = fakeQuote(quoteError);
    const settle = fakeSettle(PURCHASE);

    const attempt = decideAndBuy(REQUEST, approve(), anchor.impl, quote.impl, settle.impl);

    await expect(attempt).rejects.toThrow(/Refusing to buy/);
    await expect(attempt).rejects.toThrow(/store unreachable/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(quoteError);
    });
    expect(anchor.received).toHaveLength(0);
    expect(settle.calls).toHaveLength(0);
  });

  it("words the quote-failure message differently for a decline than an approval, since a decline was never going to buy anything", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quoteError = new Error("store unreachable");
    const quote = fakeQuote(quoteError);
    const settle = fakeSettle(PURCHASE);

    const attempt = decideAndBuy(REQUEST, decline("over the daily cap"), anchor.impl, quote.impl, settle.impl);

    await expect(attempt).rejects.toThrow(/Could not anchor this decline/);
    await expect(attempt).rejects.toThrow(/store unreachable/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(quoteError);
    });
    expect(anchor.received).toHaveLength(0);
    expect(settle.calls).toHaveLength(0);
  });

  it("generates a fresh nonce and an ISO decidedAt timestamp on every call", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(PURCHASE);

    const first = await decideAndBuy(REQUEST, approve(), anchor.impl, quote.impl, settle.impl);
    const second = await decideAndBuy(REQUEST, approve(), anchor.impl, quote.impl, settle.impl);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(() => new Date(first.decision.decidedAt).toISOString()).not.toThrow();
    expect(new Date(first.decision.decidedAt).toISOString()).toBe(first.decision.decidedAt);
  });

  it("decorates a purchase failure with the already-anchored decision, and preserves the cause", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const quote = fakeQuote(QUOTE);
    const settle = fakeSettle(new Error("insufficient_funds"));

    const attempt = decideAndBuy(REQUEST, approve(), anchor.impl, quote.impl, settle.impl);

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

    const quoteCalls: unknown[] = [];
    const quoteImpl = (async (url: string) => {
      quoteCalls.push(url);
      return QUOTE;
    }) as Parameters<typeof decideAndBuy>[3];

    const settleCalls: unknown[] = [];
    const settleImpl = (async (url: string) => {
      settleCalls.push(url);
      return PURCHASE;
    }) as Parameters<typeof decideAndBuy>[4];

    // Same REQUEST object, called twice concurrently. If decideAndBuy() held
    // any shared mutable state keyed by nonce, agent, or resource (a cache,
    // a "decision already anchored" map -- anything a replay-check would
    // need in order to exist), this would surface it: either a duplicate-
    // suppression effect (one call short-circuiting instead of anchoring) or
    // an observable race on shared state. Neither happens, because each
    // call generates its own randomUUID() nonce and performs its own
    // anchor-then-settle entirely inside one function invocation -- there is
    // no persisted "decision" a second, later call could redeem.
    const [first, second] = await Promise.all([
      decideAndBuy(REQUEST, approve(), anchorImpl, quoteImpl, settleImpl),
      decideAndBuy(REQUEST, approve(), anchorImpl, quoteImpl, settleImpl),
    ]);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(first.outcome).toBe("purchased");
    expect(second.outcome).toBe("purchased");
    expect(anchorCalls).toHaveLength(2);
    expect((anchorCalls[0] as Decision).nonce).not.toBe((anchorCalls[1] as Decision).nonce);
    expect(settleCalls).toHaveLength(2);
  });
});
