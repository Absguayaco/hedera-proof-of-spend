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
  const signer = createClientHederaSigner(
    request.operatorId,
    PrivateKey.fromString(request.operatorKey),
  );
  // x402Client's default spend controls only allow the network's "default
  // asset" (USDC on hedera:testnet, per @x402/hedera's DEFAULT_ASSETS table)
  // — native HBAR would be rejected before assertChallengeNetwork ever runs.
  // This package's actual safety gate is assertChallengeNetwork, not the
  // SDK's generic multi-asset allowlist, so that allowlist is disabled here.
  const client = new x402Client()
    .setSpendControls(false)
    .register(ALLOWED_X402_NETWORK, new ExactHederaScheme(signer));
  const httpClient = new x402HTTPClient(client);

  const challenge = await fetchImpl(request.url);
  if (challenge.status !== 402) {
    throw new Error(`expected 402 from ${request.url}, got ${challenge.status}`);
  }

  const challengeBody = await challenge.json().catch(() => undefined);
  const paymentRequired: PaymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name),
    challengeBody,
  );

  const [quoted] = paymentRequired.accepts;
  if (!quoted) {
    throw new Error(`${request.url} did not quote a price`);
  }
  // Before any signer or key material is touched: the challenge is what
  // actually decides where the money goes, so it is checked separately from
  // whatever network the SDK happens to be configured for.
  assertChallengeNetwork(quoted.network);

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
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
  const body = await paid.json();

  return { body, amountTinybar, settlement };
}

export { assertTestnet, assertChallengeNetwork } from "./guard.ts";
export { parseSettlement, hashscanUrl } from "./settlement.ts";
export type { HederaSettlement } from "./settlement.ts";
