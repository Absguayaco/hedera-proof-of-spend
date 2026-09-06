/**
 * An x402-gated service on hedera:testnet, quoting in native HBAR (0.0.0),
 * settling through a hosted facilitator.
 *
 * This is the seller side. It is a real service that must be publicly reachable
 * for the demo to be reproducible by someone who is not us.
 */
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { Hono } from "hono";
import { STORE_ASSET, STORE_NETWORK, readStoreConfig } from "./config.ts";
import { findItem, formatHbar, menuPayload } from "./menu.ts";
import { preflightFacilitator } from "./preflight.ts";
import { buildRoutes } from "./routes.ts";

export function createApp(config: ReturnType<typeof readStoreConfig>): Hono {
  const app = new Hono();

  // Free: the catalogue and health. Discovery must not cost money, or an agent
  // cannot find out what anything costs without paying first.
  app.get("/menu", (c) => c.json(menuPayload()));
  app.get("/health", (c) => c.json({ ok: true, network: STORE_NETWORK, asset: STORE_ASSET }));

  // Everything under /buy is gated. The middleware answers 402 with a payment
  // challenge, and only calls the handler below once the facilitator confirms
  // settlement.
  app.use(
    paymentMiddlewareFromConfig(
      buildRoutes(config.payTo),
      new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
      [{ network: STORE_NETWORK, server: new ExactHederaScheme() }],
    ),
  );

  app.get("/buy/:slug", (c) => {
    const item = findItem(c.req.param("slug"));
    if (!item) {
      // Only reachable for a slug with no route, which the paywall never
      // gates — so it must not read as a paid resource.
      return c.json({ error: "no such item" }, 404);
    }

    // Reached only after settlement. This is the resource that was paid for,
    // and it is what the buyer files as a receipt.
    return c.json({
      item: {
        slug: item.slug,
        name: item.name,
        priceTinybar: item.priceTinybar.toString(),
        priceHbar: formatHbar(item.priceTinybar),
      },
      servedAt: new Date().toISOString(),
      network: STORE_NETWORK,
      asset: STORE_ASSET,
    });
  });

  return app;
}

// Only start a server when run directly, so importing this module in a test
// does not bind a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = readStoreConfig();

  // Before the port is bound: a facilitator that is unreachable, or that does
  // not settle this network, must stop the boot. Otherwise the store comes up
  // looking healthy and 500s every purchase.
  try {
    const { feePayer } = await preflightFacilitator(
      new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
      STORE_NETWORK,
    );
    console.log(
      `facilitator ok — ${config.facilitatorUrl} settles exact/${STORE_NETWORK}` +
        (feePayer ? ` via fee payer ${feePayer}` : ""),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  serve({ fetch: createApp(config).fetch, port: config.port }, (info) => {
    console.log(`store listening on :${info.port} — ${STORE_NETWORK}, paid to ${config.payTo}`);
  });
}
