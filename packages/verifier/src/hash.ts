/**
 * A DELIBERATE REIMPLEMENTATION of the receipt hash.
 *
 * This file duplicates packages/anchor/src/hash.ts on purpose. It must never
 * import it. If the verifier reused the anchoring code, then "the verifier
 * agrees" would only mean "the same function returned the same answer twice",
 * which proves nothing at all.
 *
 * Written from the rule as stated in the README, not from the other file.
 * If these two ever disagree, that is a finding, not a bug to paper over by
 * making one import the other.
 *
 * Imports allowed here: node: builtins only.
 */
import { createHash } from "node:crypto";

export const HASH_VERSION = 1;

// TODO: implement from the README's stated rule — sorted keys at every level,
// no insignificant whitespace, UTF-8, SHA-256, lowercase hex.
export function canonicalize(_receipt: unknown): string {
  throw new Error("not implemented");
}

export function hashReceipt(receipt: unknown): string {
  return createHash("sha256").update(canonicalize(receipt), "utf8").digest("hex");
}
