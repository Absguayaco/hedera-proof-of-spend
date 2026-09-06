/**
 * Startup preflight against the facilitator.
 *
 * Without this the store binds its port, logs "listening", and then answers
 * every paid request with a 500 — because the payment middleware failed to load
 * supported kinds in the background and there is nowhere for that error to go.
 * A service that looks healthy and cannot sell anything is the worst of the
 * available failure modes, so the check runs before the port is bound.
 */
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, SupportedKind } from "@x402/core/types";

export interface PreflightResult {
  /** The facilitator's entry for our network and scheme. */
  readonly kind: SupportedKind;
  /** Fee payer the facilitator settles through, useful in startup logs. */
  readonly feePayer?: string;
}

/**
 * Confirm the facilitator is reachable and actually settles the scheme and
 * network this store quotes.
 *
 * Reachability alone is not enough: a facilitator that is up but does not
 * support hedera:testnet would fail at the first purchase instead of at boot,
 * which is the same problem one step later.
 */
export async function preflightFacilitator(
  facilitator: FacilitatorClient,
  network: Network,
  scheme = "exact",
): Promise<PreflightResult> {
  let supported: Awaited<ReturnType<FacilitatorClient["getSupported"]>>;
  try {
    supported = await facilitator.getSupported();
  } catch (cause) {
    throw new Error(
      `Refusing to start: could not reach the facilitator. Payment verification ` +
        `is delegated to it, so the store cannot sell anything without it. ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const kind = supported.kinds.find((k) => k.network === network && k.scheme === scheme);
  if (!kind) {
    const offered = supported.kinds.map((k) => `${k.scheme}/${k.network}`).join(", ") || "nothing";
    throw new Error(
      `Refusing to start: the facilitator does not settle ${scheme}/${network}. It offers: ${offered}.`,
    );
  }

  const feePayer = typeof kind.extra?.feePayer === "string" ? kind.extra.feePayer : undefined;
  return { kind, feePayer };
}
