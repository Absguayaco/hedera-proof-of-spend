/**
 * Vercel entry point for the store.
 *
 * The store is normally a long-running process: it preflights the facilitator,
 * then binds a port, and refuses to do the second without the first. Serverless
 * has no such moment — there is no boot, only invocations — so that guarantee
 * has to be rebuilt here rather than quietly dropped.
 *
 * What this does instead: the first invocation of each cold start runs the same
 * preflight, and the result is memoized. While it is failing, every request
 * gets 503 and the reason. A deployment that cannot settle payments therefore
 * still cannot pretend to be healthy, which was the whole point of the check.
 *
 * Importing the store module does not start a server — its `serve()` call is
 * behind a "run directly" guard, which exists for exactly this.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { handle } from "hono/vercel";
import { STORE_NETWORK, readStoreConfig } from "./config.ts";
import { createApp } from "./index.ts";
import { preflightFacilitator } from "./preflight.ts";

/** Vercel's Node.js runtime, not edge: the Hedera SDK is not edge-compatible. */
export const config = { runtime: "nodejs" };

type Ready = { ok: true; handler: (req: Request) => Response | Promise<Response> };
type Broken = { ok: false; reason: string };

let started: Promise<Ready | Broken> | undefined;

async function start(): Promise<Ready | Broken> {
  let storeConfig: ReturnType<typeof readStoreConfig>;
  try {
    storeConfig = readStoreConfig();
  } catch (error) {
    // Missing or invalid environment. Reported, not thrown: an unhandled throw
    // here surfaces as an opaque platform error with no cause attached.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    await preflightFacilitator(
      new HTTPFacilitatorClient({ url: storeConfig.facilitatorUrl }),
      STORE_NETWORK,
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, handler: handle(createApp(storeConfig)) };
}

export default async function handler(request: Request): Promise<Response> {
  // Memoized per cold start. A failed preflight is retried on the next cold
  // start rather than cached forever, so a facilitator outage recovers on its
  // own without a redeploy.
  started ??= start();
  const state = await started;

  if (!state.ok) {
    started = undefined;
    return Response.json(
      {
        error: "store unavailable",
        reason: state.reason,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return state.handler(request);
}
