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
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { hashReceipt } from "./hash.ts";
import { createTopic, submitHash } from "./topic.ts";

export interface AnchorResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly topicId?: string;
  /** Present when ok is false. Reported, never thrown. */
  readonly error?: string;
}

/** The network-facing seam. Real HCS calls in production; a fake in tests —
 *  the same shape `fetchImpl` plays in packages/buyer, but for the Hedera SDK
 *  boundary instead of HTTP. Client construction and key parsing stay real in
 *  both, matching how buyer's tests exercise real offline signing. */
export interface HcsOps {
  readonly createTopic: (client: Client) => Promise<string>;
  readonly submitHash: (client: Client, topicId: string, hash: string) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function anchorReceipt(
  receipt: unknown,
  opts: { operatorId: string; operatorKey: string; topicId?: string },
  hcs: HcsOps = { createTopic, submitHash },
): Promise<AnchorResult> {
  let hash: string;
  try {
    hash = hashReceipt(receipt);
  } catch (error) {
    // No hash is computable at all — report it visibly rather than losing
    // the purchase's anchoring step silently.
    return { ok: false, hash: "", error: describeError(error) };
  }

  try {
    const client = Client.forTestnet().setOperator(
      opts.operatorId,
      PrivateKey.fromString(opts.operatorKey),
    );
    const topicId = opts.topicId ?? (await hcs.createTopic(client));
    await hcs.submitHash(client, topicId, hash);
    return { ok: true, hash, topicId };
  } catch (error) {
    // Anchoring is best-effort: a failed anchor must never block a purchase.
    // The hash is still reported so the caller can retry or log it.
    return { ok: false, hash, error: describeError(error) };
  }
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
export { createTopic, submitHash } from "./topic.ts";
export type { AnchorMessage } from "./topic.ts";
