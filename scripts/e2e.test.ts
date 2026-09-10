import { describe, expect, it, vi } from "vitest";
import {
  bindReceiptToDecision,
  buildDescribePurchase,
  buildReceipt,
  fetchMenu,
  slugFromResource,
  tinybarToNominalUsd,
  verifyWithRetry,
} from "./e2e.ts";
import type { MenuItemPrice } from "./e2e.ts";
import { hashReceipt } from "@proof-of-spend/anchor";
import type { BuyResult } from "@proof-of-spend/buyer";
import type { Decision } from "./decide-and-buy.ts";
import type { VerifyResult } from "@proof-of-spend/verifier";

describe("tinybarToNominalUsd", () => {
  it("prices the menu's three real amounts at the nominal 1 HBAR = $1.00 rate", () => {
    expect(tinybarToNominalUsd(15_000_000n)).toBe(0.15); // espresso
    expect(tinybarToNominalUsd(25_000_000n)).toBe(0.25); // flat-white
    expect(tinybarToNominalUsd(35_000_000n)).toBe(0.35); // cold-brew
  });

  it("throws on a non-positive amount rather than silently pricing it at zero", () => {
    expect(() => tinybarToNominalUsd(0n)).toThrow(/non-positive/);
    expect(() => tinybarToNominalUsd(-1n)).toThrow(/non-positive/);
  });
});

describe("slugFromResource", () => {
  it("extracts the last path segment as the menu slug", () => {
    expect(slugFromResource("https://store.example/buy/espresso")).toBe("espresso");
  });

  it("throws on a URL with no path segments", () => {
    expect(() => slugFromResource("https://store.example/")).toThrow(/Cannot determine/);
  });
});

describe("fetchMenu", () => {
  const fakeMenuResponse = (): Response =>
    new Response(
      JSON.stringify({
        items: [
          { slug: "espresso", name: "Espresso", priceTinybar: "15000000" },
          { slug: "cold-brew", name: "Cold brew", priceTinybar: "35000000" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("parses the store's real menuPayload() shape into a slug-keyed map of bigint prices", async () => {
    const fetchImpl = (async () => fakeMenuResponse()) as typeof fetch;
    const menu = await fetchMenu("https://store.example", fetchImpl);
    expect(menu.get("espresso")).toEqual({
      slug: "espresso",
      name: "Espresso",
      priceTinybar: 15_000_000n,
    });
    expect(menu.get("cold-brew")?.priceTinybar).toBe(35_000_000n);
  });

  it("throws on a non-2xx response, naming the status", async () => {
    const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(fetchMenu("https://store.example", fetchImpl)).rejects.toThrow(/503/);
  });

  it("throws on a 200 with no items[] array", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    await expect(fetchMenu("https://store.example", fetchImpl)).rejects.toThrow(/items/);
  });
});

describe("buildDescribePurchase", () => {
  const menu: ReadonlyMap<string, MenuItemPrice> = new Map([
    ["espresso", { slug: "espresso", name: "Espresso", priceTinybar: 15_000_000n }],
  ]);

  it("looks up the slug from the resource URL and prices it at the nominal rate", () => {
    const describePurchase = buildDescribePurchase(menu);
    const purchase = describePurchase({
      agent: "agent",
      resource: "https://store.example/buy/espresso",
    });
    expect(purchase.amount).toBe(0.15);
    expect(purchase.currency).toBe("USD");
    expect(purchase.merchant).toBe("hedera-proof-of-spend store");
  });

  it("throws naming the slug when the resource isn't in the fetched menu", () => {
    const describePurchase = buildDescribePurchase(menu);
    expect(() =>
      describePurchase({ agent: "agent", resource: "https://store.example/buy/unknown-item" }),
    ).toThrow(/unknown-item/);
  });
});

describe("buildReceipt", () => {
  it("builds a hash-spec-compliant receipt: numbers as decimal strings, keys unsorted (the hasher sorts them)", () => {
    const purchase: BuyResult = {
      body: { ok: true },
      amountTinybar: 15_000_000n,
      settlement: {
        transactionId: "0.0.12345@1699999999.123456789",
        feePayer: "0.0.12345",
        validStartSeconds: 1699999999,
        validStartNanos: 123456789,
      },
    };
    const receipt = buildReceipt("espresso", purchase);
    expect(receipt).toEqual({
      rail: "hedera",
      item: { slug: "espresso" },
      amountTinybar: "15000000",
      settlement: {
        transactionId: "0.0.12345@1699999999.123456789",
        feePayer: "0.0.12345",
        validStartSeconds: "1699999999",
        validStartNanos: "123456789",
      },
    });
  });
});

describe("bindReceiptToDecision", () => {
  const DECISION: Decision = {
    agent: "hedera-proof-of-spend-e2e-agent",
    resource: "https://store.example/buy/espresso",
    verdict: "approved",
    budgetRuleId: "rule-1",
    nonce: "11111111-1111-1111-1111-111111111111",
    decidedAt: "2026-09-10T00:00:00.000Z",
  };

  it("attaches both the structured {nonce,topicId,sequenceNumber} reference (B2/B3) and the full Decision object (authorizingDecision) a third party needs to independently re-verify it", () => {
    const receipt = { rail: "hedera", amountTinybar: "15000000" };

    const bound = bindReceiptToDecision(receipt, DECISION, {
      topicId: "0.0.777",
      sequenceNumber: "42",
    });

    expect(bound).toEqual({
      rail: "hedera",
      amountTinybar: "15000000",
      decision: { nonce: DECISION.nonce, topicId: "0.0.777", sequenceNumber: "42" },
      authorizingDecision: DECISION,
    });
  });

  it("does not mutate the original receipt object", () => {
    const receipt = { rail: "hedera" };

    bindReceiptToDecision(receipt, DECISION, { topicId: "0.0.777", sequenceNumber: "1" });

    expect(receipt).toEqual({ rail: "hedera" });
  });

  it("throws naming the decision's nonce when the anchor's topicId is missing, rather than binding to a fabricated topic", () => {
    expect(() =>
      bindReceiptToDecision({ rail: "hedera" }, DECISION, {
        topicId: undefined,
        sequenceNumber: "1",
      }),
    ).toThrow(new RegExp(DECISION.nonce));
  });

  it("throws naming the decision's nonce when the anchor's sequenceNumber is missing", () => {
    expect(() =>
      bindReceiptToDecision({ rail: "hedera" }, DECISION, {
        topicId: "0.0.777",
        sequenceNumber: undefined,
      }),
    ).toThrow(new RegExp(DECISION.nonce));
  });

  it("keeps authorizingDecision hashable identically to the original Decision, even when optional fields are present as undefined-valued keys (decideAndBuy()'s real shape when askReceipts returns no rule) and get dropped by a JSON round-trip", () => {
    const decisionWithUndefinedOptionals: Decision = {
      agent: "hedera-proof-of-spend-e2e-agent",
      resource: "https://store.example/buy/espresso",
      verdict: "approved",
      budgetRuleId: undefined,
      reason: undefined,
      nonce: "22222222-2222-2222-2222-222222222222",
      decidedAt: "2026-09-10T00:00:00.000Z",
    };

    const bound = bindReceiptToDecision({ rail: "hedera" }, decisionWithUndefinedOptionals, {
      topicId: "0.0.777",
      sequenceNumber: "1",
    });

    // authorizingDecision only ever reaches a third party after a JSON
    // round-trip (it's printed as JSON in step 3, and anchored/rehashed as
    // JSON): confirms hashReceipt() drops undefined-valued keys identically
    // on both sides, so the hash a third party recomputes from the receipt
    // still matches the one this script actually anchored.
    const roundTripped: unknown = JSON.parse(JSON.stringify(bound.authorizingDecision));
    expect(hashReceipt(decisionWithUndefinedOptionals)).toBe(hashReceipt(roundTripped));
  });
});

describe("verifyWithRetry", () => {
  function matchResult(): VerifyResult {
    return {
      outcome: "match",
      computedHash: "a".repeat(64),
      consensusTimestamp: "1788825896.100000000",
      sequenceNumber: 1,
      hashscanUrl: "https://hashscan.io/testnet/topic/0.0.777/messages",
    };
  }

  it("returns immediately on a first-attempt match, without sleeping", async () => {
    const verifyImpl = vi.fn(async () => matchResult());
    const sleepImpl = vi.fn(async () => {});

    const result = await verifyWithRetry({}, { topicId: "0.0.777" }, "receipt", verifyImpl, sleepImpl);

    expect(result.outcome).toBe("match");
    expect(verifyImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retries on a 'missing' outcome (mirror-node ingestion lag), succeeding once it appears", async () => {
    let call = 0;
    const verifyImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? { outcome: "missing" as const, computedHash: "a".repeat(64) } : matchResult();
    });
    const sleepImpl = vi.fn(async () => {});

    const result = await verifyWithRetry({}, { topicId: "0.0.777" }, "receipt", verifyImpl, sleepImpl);

    expect(result.outcome).toBe("match");
    expect(verifyImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after 6 attempts, returning the last 'missing' result rather than retrying forever", async () => {
    const verifyImpl = vi.fn(async () => ({ outcome: "missing" as const, computedHash: "a".repeat(64) }));
    const sleepImpl = vi.fn(async () => {});

    const result = await verifyWithRetry({}, { topicId: "0.0.777" }, "receipt", verifyImpl, sleepImpl);

    expect(result.outcome).toBe("missing");
    expect(verifyImpl).toHaveBeenCalledTimes(6);
    expect(sleepImpl).toHaveBeenCalledTimes(5);
  });

  it("propagates a thrown error from verifyImpl rather than swallowing it as a retry", async () => {
    const verifyImpl = vi.fn(async () => {
      throw new Error("mirror node unreachable");
    });

    await expect(
      verifyWithRetry({}, { topicId: "0.0.777" }, "receipt", verifyImpl, async () => {}),
    ).rejects.toThrow(/mirror node unreachable/);
  });
});
