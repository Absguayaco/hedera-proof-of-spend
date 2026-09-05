/**
 * An independent verifier.
 *
 * Takes a receipt, hashes it, queries the HCS topic, and reports one of three
 * outcomes. It depends on nothing of ours: one public Hedera SDK and node's
 * standard library. See this package's package.json — that dependency list is
 * the claim, and a workspace dependency added there would quietly void it.
 *
 * What each outcome means:
 *   match   — this is exactly what was recorded, at the time claimed
 *   missing — never anchored; may have been added to the ledger afterwards
 *   altered — a hash was anchored for this receipt id, but the receipt differs,
 *             so the record changed after the fact
 *
 * What this does NOT prove: that the receipt is true. A ledger that files a
 * wrong receipt and anchors it has anchored a wrong receipt, immutably. This
 * is tamper-evidence, not correctness.
 */
export type Outcome = "match" | "missing" | "altered";

export interface VerifyResult {
  readonly outcome: Outcome;
  /** The hash this verifier computed, independently, from the receipt. */
  readonly computedHash: string;
  /** Consensus timestamp of the anchoring message, when one was found. */
  readonly consensusTimestamp?: string;
  /** Link to the same message on HashScan, on a network neither party controls. */
  readonly hashscanUrl?: string;
}

// TODO: implement.
//   1. hashReceipt() the receipt with THIS package's own implementation
//   2. query the topic via the public mirror node
//   3. match / missing / altered
export async function verify(
  _receipt: unknown,
  _opts: { topicId: string; network?: string },
): Promise<VerifyResult> {
  throw new Error("not implemented");
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
