/**
 * Agent-side HCS anchoring.
 *
 * This runs entirely on the agent side. The receipt ledger never touches
 * Hedera and does not know anchoring exists — which is what keeps the ledger a
 * dependency rather than something this project extends.
 *
 * Anchoring is BEST-EFFORT by design. A failed anchor must never block a
 * purchase or lose a receipt: an unanchored receipt is worth more than a lost
 * one, and it is visibly unanchored, which is the correct failure mode.
 */
export interface AnchorResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly topicId?: string;
  /** Present when ok is false. Reported, never thrown. */
  readonly error?: string;
}

// TODO: implement. Must catch everything: any throw from the SDK becomes
// { ok: false, error }, never a rejected promise. Callers depend on that.
export async function anchorReceipt(
  _receipt: unknown,
  _opts: { operatorId: string; operatorKey: string; topicId?: string },
): Promise<AnchorResult> {
  throw new Error("not implemented");
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
export { createTopic, submitHash } from "./topic.ts";
export type { AnchorMessage } from "./topic.ts";
