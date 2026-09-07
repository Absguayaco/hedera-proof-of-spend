/**
 * A thin x402 client that speaks exactly one rail: the Hedera exact-payment
 * scheme, settling in native HBAR (0.0.0) through a hosted facilitator.
 *
 * This is deliberately NOT a general multi-rail buyer with the other rails
 * removed. There is no rail registry, no funding seam, and nothing pluggable.
 * If this file grows a second rail, the claim in the README stops being true.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactHederaScheme, PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ALLOWED_X402_NETWORK, assertChallengeNetwork } from "./guard.ts";
import { parseSettlement } from "./settlement.ts";
import type { HederaSettlement } from "./settlement.ts";

export interface BuyRequest {
  /** The x402-gated resource to fetch. */
  readonly url: string;
  readonly operatorId: string;
  readonly operatorKey: string;
}

export interface BuyResult {
  /** The resource body, once paid for. */
  readonly body: unknown;
  /** What the store charged, in tinybar, as quoted in the 402 challenge. */
  readonly amountTinybar: bigint;
  readonly settlement: HederaSettlement;
}

/**
 * Buys one resource: GET, expect 402, pay via the Hedera exact scheme, retry.
 *
 * Orchestrated explicitly rather than via `wrapFetchWithPayment` so that
 * `assertChallengeNetwork()` — this package's whole reason a raw private key
 * is acceptable to sign from — is what actually fires, with its specific
 * message, on a bad network quote. `wrapFetchWithPayment` would instead
 * surface a generic "no scheme registered" failure from `@x402/core`,
 * bypassing the guard entirely.
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can inject a
 * fake HTTP layer without touching `globalThis`.
 */
export async function buyResource(
  request: BuyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<BuyResult> {
  const challenge = await fetchImpl(request.url);
  if (challenge.status !== 402) {
    throw new Error(`expected 402 from ${request.url}, got ${challenge.status}`);
  }

  const challengeBody = await challenge.json().catch(() => undefined);
  const paymentRequired: PaymentRequired = new x402HTTPClient(
    new x402Client(),
  ).getPaymentRequiredResponse((name) => challenge.headers.get(name), challengeBody);

  const [quoted] = paymentRequired.accepts;
  if (!quoted) {
    throw new Error(`${request.url} did not quote a price`);
  }
  // The challenge is what actually decides where the money goes and what it
  // buys, so it is checked before any signer is built or key material is
  // used — not just against whatever network the SDK happens to be
  // configured for, but against this package's one supported rail.
  assertChallengeNetwork(quoted.network);
  if (quoted.asset !== "0.0.0") {
    throw new Error(`store quoted asset "${quoted.asset}", not native HBAR (0.0.0)`);
  }
  if (quoted.scheme !== "exact") {
    throw new Error(`store quoted scheme "${quoted.scheme}", not "exact"`);
  }

  const signer = createClientHederaSigner(
    request.operatorId,
    PrivateKey.fromString(request.operatorKey),
  );
  // x402Client's default spend controls only allow the network's "default
  // asset" (USDC on hedera:testnet, per @x402/hedera's DEFAULT_ASSETS table)
  // — native HBAR would be rejected before assertChallengeNetwork ever runs.
  // Scoped to exactly this network and asset, with an explicit atomic cap,
  // rather than disabling spend controls outright: `setSpendControls(false)`
  // would also forfeit the ability to cap the payment at all, since HBAR was
  // never a recognized "default asset" the SDK's own $1 cap applies to in
  // the first place — it was simply blocked, not capped. This cap is a
  // backstop against a malicious or misbehaving store quoting an absurd
  // amount; it is deliberately generous relative to this store's menu
  // (packages/store/src/menu.ts tops out at 0.35 HBAR) rather than coupled
  // to it — this package is seller-agnostic and must not know a specific
  // store's catalogue.
  const MAX_TINYBAR_PER_PAYMENT = "100000000"; // 1 HBAR
  const client = new x402Client()
    .setSpendControls({
      allowedAssets: [
        {
          network: ALLOWED_X402_NETWORK,
          asset: "0.0.0",
          maxAmountPerPayment: MAX_TINYBAR_PER_PAYMENT,
        },
      ],
    })
    .register(ALLOWED_X402_NETWORK, new ExactHederaScheme(signer));
  const httpClient = new x402HTTPClient(client);

  // Narrowed to just the entry the guard above validated, so the SDK cannot
  // select and pay a different `accepts[]` entry than the one
  // `amountTinybar` below is read from.
  const paymentPayload = await httpClient.createPaymentPayload({
    ...paymentRequired,
    accepts: [quoted],
  });
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paid = await fetchImpl(request.url, { headers: paymentHeaders });

  let settleResponse: SettleResponse;
  try {
    settleResponse = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
  } catch (error) {
    throw new Error(
      `store did not return a settlement after payment (status ${paid.status}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  if (!settleResponse.success) {
    const reason = settleResponse.errorReason ?? "unknown";
    const detail = settleResponse.errorMessage ? ` — ${settleResponse.errorMessage}` : "";
    throw new Error(`payment failed: ${reason}${detail}`);
  }

  const settlement = parseSettlement(settleResponse.transaction);
  const amountTinybar = BigInt(quoted.amount);
  const body = await paid.json().catch((error: unknown) => {
    throw new Error(
      `store returned an unparseable body after a successful payment (status ${paid.status}, ` +
        `transaction ${settlement.transactionId}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  });

  return { body, amountTinybar, settlement };
}

export { assertTestnet, assertChallengeNetwork } from "./guard.ts";
export { parseSettlement, hashscanUrl } from "./settlement.ts";
export type { HederaSettlement } from "./settlement.ts";
