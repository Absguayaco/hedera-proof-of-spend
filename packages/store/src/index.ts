/**
 * An x402-gated service on hedera:testnet, quoting in native HBAR (0.0.0),
 * settling through Blocky402 as the hosted facilitator.
 *
 * This is the seller side. It is a real service that must be publicly reachable
 * for the demo to be reproducible by someone who is not us.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MENU } from "./menu.ts";

const app = new Hono();

// Free: the catalogue. Discovery must not cost money, or an agent cannot find
// out what anything costs without paying first.
app.get("/menu", (c) => c.json({ items: MENU }));

// TODO: mount the x402 paywall (@x402/hono) over /buy/:slug
//   - network: "hedera:testnet"
//   - asset:   native HBAR (0.0.0)
//   - payTo:   STORE_PAYEE_ID
//   - facilitator: FACILITATOR_URL (Blocky402)
// The paid handler returns the resource only after settlement.

app.get("/health", (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 8402);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`store listening on :${info.port}`);
});
