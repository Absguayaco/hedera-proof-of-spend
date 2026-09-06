import type { RouteConfig } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import { STORE_ASSET, STORE_NETWORK } from "./config.ts";
import { MENU } from "./menu.ts";
import { buildRoutes } from "./routes.ts";

const PAY_TO = "0.0.54321";
const routes = buildRoutes(PAY_TO) as Record<string, RouteConfig>;

/** Narrow `accepts`, which the type allows to be an array. */
function acceptsOf(key: string) {
  const accepts = (routes[key] as { accepts: unknown }).accepts;
  return Array.isArray(accepts) ? accepts[0] : accepts;
}

describe("buildRoutes", () => {
  it("builds one route per catalogue item", () => {
    expect(Object.keys(routes)).toHaveLength(MENU.length);
  });

  it("gates GET specifically, not every verb", () => {
    for (const key of Object.keys(routes)) {
      expect(key.startsWith("GET /buy/")).toBe(true);
    }
  });

  it("quotes hedera testnet on every route", () => {
    for (const key of Object.keys(routes)) {
      expect(acceptsOf(key).network).toBe(STORE_NETWORK);
    }
  });

  it("prices in native HBAR, not a USD-pegged default", () => {
    for (const key of Object.keys(routes)) {
      // A "$0.10" Money string would resolve through the network's default
      // asset, which on Hedera is USDC. This project settles in HBAR.
      expect(acceptsOf(key).price).toMatchObject({ asset: STORE_ASSET });
    }
  });

  it("carries the amount as an integer string of tinybar", () => {
    for (const item of MENU) {
      const price = acceptsOf(`GET /buy/${item.slug}`).price;
      expect(price.amount).toBe(item.priceTinybar.toString());
      expect(price.amount).toMatch(/^\d+$/);
    }
  });

  it("pays every route to the configured account", () => {
    for (const key of Object.keys(routes)) {
      expect(acceptsOf(key).payTo).toBe(PAY_TO);
    }
  });

  it("cannot drift from the price the menu advertises", () => {
    // The routes are derived from MENU, so this holds by construction — the
    // test exists to fail loudly if someone hardcodes a price later.
    for (const item of MENU) {
      expect(acceptsOf(`GET /buy/${item.slug}`).price.amount).toBe(item.priceTinybar.toString());
    }
  });

  it("tells an unpaid caller what it is being asked to buy", () => {
    // The default unpaid body is an empty object, which tells an agent nothing
    // about what it was asked to buy or why the request failed.
    const unpaid = routes["GET /buy/espresso"].unpaidResponseBody;
    expect(unpaid).toBeDefined();

    // The handler ignores its context argument; the type still requires one.
    const call = unpaid as unknown as () => { body: { item: { priceHbar: string } } };
    expect(call().body.item.priceHbar).toBe("0.15");
  });
});
