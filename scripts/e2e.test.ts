import { describe, expect, it } from "vitest";
import {
  buildDescribePurchase,
  buildReceipt,
  fetchMenu,
  slugFromResource,
  tinybarToNominalUsd,
} from "./e2e.ts";
import type { MenuItemPrice } from "./e2e.ts";
import type { BuyResult } from "@proof-of-spend/buyer";

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
