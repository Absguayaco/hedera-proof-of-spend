/**
 * A thin x402 client that speaks exactly one rail: the Hedera exact-payment
 * scheme, settling in native HBAR (0.0.0) through a hosted facilitator.
 *
 * This is deliberately NOT a general multi-rail buyer with the other rails
 * removed. There is no rail registry, no funding seam, and nothing pluggable.
 * If this file grows a second rail, the claim in the README stops being true.
 */
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

// TODO: implement.
//   1. GET the url, expect 402
//   2. assertChallengeNetwork() on the quoted network before signing anything
//   3. pay via the Hedera exact scheme (@x402/hedera + @x402/fetch)
//   4. parseSettlement() the facilitator's reference
//   5. return the resource with its settlement
export async function buyResource(_request: BuyRequest): Promise<BuyResult> {
  throw new Error("not implemented");
}

export { assertTestnet, assertChallengeNetwork } from "./guard.ts";
export { parseSettlement, hashscanUrl } from "./settlement.ts";
export type { HederaSettlement } from "./settlement.ts";
