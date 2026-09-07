// packages/store/src/vercel.ts
import { HTTPFacilitatorClient as HTTPFacilitatorClient2 } from "@x402/core/server";
import { handle } from "hono/vercel";

// packages/store/src/config.ts
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2, isValidHederaEntityId } from "@x402/hedera";
var STORE_NETWORK = HEDERA_TESTNET_CAIP2;
var STORE_ASSET = HBAR_ASSET_ID;
function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. The store will not guess a default for it \u2014 see .env.example.`
    );
  }
  return value;
}
function assertSafeFacilitatorUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FACILITATOR_URL is not a valid URL.");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `Refusing to start: FACILITATOR_URL must be https (got ${url.protocol.replace(":", "")}). Payment verification is delegated to it.`
    );
  }
  return url.toString();
}
function readStoreConfig(env = process.env) {
  const network = env.HEDERA_NETWORK?.trim();
  if (network && network !== "testnet" && network !== STORE_NETWORK) {
    throw new Error(
      `Refusing to start: HEDERA_NETWORK is "${network}". This store quotes ${STORE_NETWORK} only.`
    );
  }
  const payTo = requireEnv(env, "STORE_PAYEE_ID");
  if (!isValidHederaEntityId(payTo)) {
    throw new Error(
      `STORE_PAYEE_ID is not a Hedera account id (got "${payTo}"). Expected shard.realm.num, e.g. 0.0.54321.`
    );
  }
  const facilitatorUrl = assertSafeFacilitatorUrl(requireEnv(env, "FACILITATOR_URL"));
  const rawPort = env.PORT?.trim();
  const port = rawPort === void 0 || rawPort === "" ? 8402 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT is not a valid port number (got "${rawPort}").`);
  }
  return { payTo, facilitatorUrl, port };
}

// packages/store/src/index.ts
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { Hono } from "hono";

// packages/store/src/menu.ts
var TINYBAR_PER_HBAR = 100000000n;
var MENU = [
  {
    slug: "espresso",
    name: "Espresso",
    priceTinybar: 15000000n,
    description: "A single shot. The cheapest thing an agent can buy here."
  },
  {
    slug: "flat-white",
    name: "Flat white",
    priceTinybar: 25000000n,
    description: "Double ristretto, steamed milk."
  },
  {
    slug: "cold-brew",
    name: "Cold brew",
    priceTinybar: 35000000n,
    description: "Steeped eighteen hours. Served over ice."
  }
];
function findItem(slug) {
  return MENU.find((item) => item.slug === slug);
}
function formatHbar(tinybar) {
  const negative = tinybar < 0n;
  const absolute = negative ? -tinybar : tinybar;
  const whole = absolute / TINYBAR_PER_HBAR;
  const fraction = absolute % TINYBAR_PER_HBAR;
  const fractionDigits = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  const body = fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : `${whole}`;
  return negative ? `-${body}` : body;
}
function menuPayload() {
  return {
    items: MENU.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      priceTinybar: item.priceTinybar.toString(),
      priceHbar: formatHbar(item.priceTinybar),
      href: `/buy/${item.slug}`
    }))
  };
}

// packages/store/src/preflight.ts
async function preflightFacilitator(facilitator, network, scheme = "exact") {
  let supported;
  try {
    supported = await facilitator.getSupported();
  } catch (cause) {
    throw new Error(
      `Refusing to start: could not reach the facilitator. Payment verification is delegated to it, so the store cannot sell anything without it. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
  const kind = supported.kinds.find((k) => k.network === network && k.scheme === scheme);
  if (!kind) {
    const offered = supported.kinds.map((k) => `${k.scheme}/${k.network}`).join(", ") || "nothing";
    throw new Error(
      `Refusing to start: the facilitator does not settle ${scheme}/${network}. It offers: ${offered}.`
    );
  }
  const feePayer = typeof kind.extra?.feePayer === "string" ? kind.extra.feePayer : void 0;
  return { kind, feePayer };
}

// packages/store/src/routes.ts
function buildRoutes(payTo) {
  const routes = {};
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
          amount: item.priceTinybar.toString()
        }
      },
      description: `${item.name} \u2014 ${formatHbar(item.priceTinybar)} HBAR`,
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
            priceHbar: formatHbar(item.priceTinybar)
          },
          hint: "Pay the x402 challenge on hedera:testnet in native HBAR (asset 0.0.0)."
        }
      })
    };
  }
  return routes;
}

// packages/store/src/index.ts
function createApp(config2) {
  const app = new Hono();
  app.get("/menu", (c) => c.json(menuPayload()));
  app.get("/health", (c) => c.json({ ok: true, network: STORE_NETWORK, asset: STORE_ASSET }));
  app.use(
    paymentMiddlewareFromConfig(
      buildRoutes(config2.payTo),
      new HTTPFacilitatorClient({ url: config2.facilitatorUrl }),
      [{ network: STORE_NETWORK, server: new ExactHederaScheme() }]
    )
  );
  app.get("/buy/:slug", (c) => {
    const item = findItem(c.req.param("slug"));
    if (!item) {
      return c.json({ error: "no such item" }, 404);
    }
    return c.json({
      item: {
        slug: item.slug,
        name: item.name,
        priceTinybar: item.priceTinybar.toString(),
        priceHbar: formatHbar(item.priceTinybar)
      },
      servedAt: (/* @__PURE__ */ new Date()).toISOString(),
      network: STORE_NETWORK,
      asset: STORE_ASSET
    });
  });
  return app;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config2 = readStoreConfig();
  try {
    const { feePayer } = await preflightFacilitator(
      new HTTPFacilitatorClient({ url: config2.facilitatorUrl }),
      STORE_NETWORK
    );
    console.log(
      `facilitator ok \u2014 ${config2.facilitatorUrl} settles exact/${STORE_NETWORK}` + (feePayer ? ` via fee payer ${feePayer}` : "")
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  serve({ fetch: createApp(config2).fetch, port: config2.port }, (info) => {
    console.log(`store listening on :${info.port} \u2014 ${STORE_NETWORK}, paid to ${config2.payTo}`);
  });
}

// packages/store/src/vercel.ts
var config = { runtime: "nodejs" };
var started;
async function start() {
  let storeConfig;
  try {
    storeConfig = readStoreConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    await preflightFacilitator(
      new HTTPFacilitatorClient2({ url: storeConfig.facilitatorUrl }),
      STORE_NETWORK
    );
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, handler: handle(createApp(storeConfig)) };
}
async function handler(request) {
  started ??= start();
  const state = await started;
  if (!state.ok) {
    started = void 0;
    return Response.json(
      {
        error: "store unavailable",
        reason: state.reason
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
  return state.handler(request);
}
export {
  config,
  handler as default
};
