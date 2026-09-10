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
 * A validated x402 payment quote for one resource: the store's real,
 * live-quoted amount and payee, checked against this package's one
 * supported rail (hedera:testnet, native HBAR, exact scheme) -- everything
 * buyResource() used to validate before signing anything, now available on
 * its own so a caller (scripts/decide-and-buy.ts) can learn what a purchase
 * actually costs, and to whom, BEFORE deciding whether to pay -- and can
 * then pay against this EXACT quote via settleQuote(), instead of fetching
 * (and risking a different) quote a second time.
 *
 * `paymentRequired`/`accepted` are SDK plumbing settleQuote() needs to
 * actually construct and sign a payment. Any other caller only ever reads
 * `amountTinybar`/`payTo` and should treat the rest as opaque.
 */
export interface HederaQuote {
  readonly amountTinybar: string;
  readonly payTo: string;
  readonly paymentRequired: PaymentRequired;
  readonly accepted: PaymentRequired["accepts"][number];
}

/**
 * A rejected payment can come back as a fresh 402 challenge rather than a
 * settlement failure. When it does, that challenge's `error` field carries
 * the facilitator's specific rejection reason — this decodes it, returning
 * `undefined` for anything else (a non-402 status, no PAYMENT-REQUIRED
 * header, or a challenge with no `error` set) so the caller can fall back to
 * a generic message.
 */
function rejectionReason(
  httpClient: x402HTTPClient,
  response: Response,
  body: unknown,
): string | undefined {
  if (response.status !== 402) return undefined;
  try {
    return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body)
      .error;
  } catch {
    return undefined;
  }
}

/**
 * Fetches the x402 challenge for a resource and validates it against this
 * package's one supported rail, before any signer is built or key material
 * is used — the challenge is what actually decides where the money goes and
 * what it buys, so it is checked first, not just against whatever network
 * the SDK happens to be configured for.
 */
export async function quoteResource(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HederaQuote> {
  const challenge = await fetchImpl(url);
  if (challenge.status !== 402) {
    throw new Error(`expected 402 from ${url}, got ${challenge.status}`);
  }

  const challengeBody = await challenge.json().catch(() => undefined);
  const paymentRequired: PaymentRequired = new x402HTTPClient(
    new x402Client(),
  ).getPaymentRequiredResponse((name) => challenge.headers.get(name), challengeBody);

  const [quoted] = paymentRequired.accepts;
  if (!quoted) {
    throw new Error(`${url} did not quote a price`);
  }
  assertChallengeNetwork(quoted.network);
  if (quoted.asset !== "0.0.0") {
    throw new Error(`store quoted asset "${quoted.asset}", not native HBAR (0.0.0)`);
  }
  if (quoted.scheme !== "exact") {
    throw new Error(`store quoted scheme "${quoted.scheme}", not "exact"`);
  }

  return { amountTinybar: quoted.amount, payTo: quoted.payTo, paymentRequired, accepted: quoted };
}

/**
 * Pays a quote already obtained from quoteResource() and returns the settled
 * purchase. Split out from buyResource() so a caller can anchor a decision
 * against the exact quote it is about to pay, rather than fetching (and
 * risking a different) one a second time.
 */
export async function settleQuote(
  url: string,
  quote: HederaQuote,
  operatorId: string,
  operatorKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BuyResult> {
  // Re-asserted here, not just inside quoteResource(): nothing in the type
  // system stops a caller from handing settleQuote() a hand-built or
  // otherwise-sourced HederaQuote. Without this, a bad network would still
  // be caught by the spend-control scoping below, but only with @x402/core's
  // generic "no scheme registered" error -- exactly the un-actionable
  // failure assertChallengeNetwork() exists to replace with a specific one.
  assertChallengeNetwork(quote.accepted.network);
  const signer = createClientHederaSigner(operatorId, PrivateKey.fromString(operatorKey));
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

  // Narrowed to just the entry quoteResource() validated, so the SDK cannot
  // select and pay a different `accepts[]` entry than the one this quote's
  // amountTinybar/payTo were read from.
  const paymentPayload = await httpClient.createPaymentPayload({
    ...quote.paymentRequired,
    accepts: [quote.accepted],
  });
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paid = await fetchImpl(url, { headers: paymentHeaders });

  let settleResponse: SettleResponse;
  try {
    settleResponse = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
  } catch (error) {
    // A rejected payment does not always come back as a settlement failure —
    // the store's middleware can instead reissue a fresh 402 challenge, with
    // the rejection reason in its `error` field (e.g. a self-payment, where
    // payer and payTo are the same account and the transfer nets to zero,
    // comes back as "invalid_exact_hedera_payload_amount_mismatch"). Surface
    // that specific reason when it's there, rather than only the generic
    // "no settlement header" message below.
    const retryBody = await paid.json().catch(() => undefined);
    const reason = rejectionReason(httpClient, paid, retryBody);
    if (reason) {
      throw new Error(`payment rejected: ${reason}`);
    }
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
  // Read from quote.amountTinybar -- the same field scripts/decide-and-buy.ts
  // anchors into Decision.amount -- not quote.accepted.amount. Both are set
  // from the same source inside quoteResource() and so agree today, but
  // deriving BuyResult's reported amount from a DIFFERENT field of the same
  // quote than the one that gets anchored would make that agreement
  // incidental rather than structural -- exactly the distinction the
  // anchored-vs-paid amount binding this package exists to support depends on.
  const amountTinybar = BigInt(quote.amountTinybar);
  const body = await paid.json().catch((error: unknown) => {
    throw new Error(
      `store returned an unparseable body after a successful payment (status ${paid.status}, ` +
        `transaction ${settlement.transactionId}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  });

  return { body, amountTinybar, settlement };
}

/**
 * Buys one resource: GET, expect 402, pay via the Hedera exact scheme, retry.
 *
 * Orchestrated explicitly rather than via `wrapFetchWithPayment` so that
 * `assertChallengeNetwork()` — this package's whole reason a raw private key
 * is acceptable to sign from — is what actually fires, with its specific
 * message, on a bad network quote (inside quoteResource(), called first).
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can inject a
 * fake HTTP layer without touching `globalThis`.
 */
export async function buyResource(
  request: BuyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<BuyResult> {
  const quote = await quoteResource(request.url, fetchImpl);
  return settleQuote(request.url, quote, request.operatorId, request.operatorKey, fetchImpl);
}

export { assertTestnet, assertChallengeNetwork } from "./guard.ts";
export { parseSettlement, hashscanUrl } from "./settlement.ts";
export type { HederaSettlement } from "./settlement.ts";
