/**
 * Route configuration for the x402 paywall.
 *
 * One route per catalogue item rather than a single `/buy/:slug` pattern,
 * because price is a property of the route: a wildcard route can only carry one
 * price, and every item here costs something different. Building them from MENU
 * keeps the catalogue the single source of truth — a route cannot drift from
 * the price the menu advertises.
 *
 * Kept separate from index.ts and free of side effects so it can be tested
 * without starting a server or reaching a facilitator.
 */
import type { RouteConfig, RoutesConfig } from "@x402/core/server";
import { STORE_ASSET, STORE_NETWORK } from "./config.ts";
import { MENU, formatHbar } from "./menu.ts";

export function buildRoutes(payTo: string): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};

  for (const item of MENU) {
    routes[`GET /buy/${item.slug}`] = {
      accepts: {
        scheme: "exact",
        network: STORE_NETWORK,
        payTo,
        // An explicit AssetAmount, not a "$0.10" Money string. Money resolves
        // through the network's USD-pegged default asset, which on Hedera is
        // USDC — and this store settles in native HBAR.
        price: {
          asset: STORE_ASSET,
          amount: item.priceTinybar.toString(),
        },
      },
      description: `${item.name} — ${formatHbar(item.priceTinybar)} HBAR`,
      mimeType: "application/json",
      serviceName: "Proof of Spend demo store",

      // What an agent gets back when it asks without paying. The default is an
      // empty object, which tells the agent nothing about what it is being
      // asked to buy or why the request failed.
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "payment required",
          item: {
            slug: item.slug,
            name: item.name,
            priceTinybar: item.priceTinybar.toString(),
            priceHbar: formatHbar(item.priceTinybar),
          },
          hint: "Pay the x402 challenge on hedera:testnet in native HBAR (asset 0.0.0).",
        },
      }),
    };
  }

  return routes;
}
