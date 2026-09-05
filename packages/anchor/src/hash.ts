/**
 * Canonicalisation and hashing of a filed receipt.
 *
 * The hash must be reproducible by someone who has the receipt and none of our
 * code, so the rule has to be simple enough to restate in one paragraph in the
 * README — and it is restated, independently, in packages/verifier/src/hash.ts.
 * Those two files agreeing is the whole proof. Do NOT make them import each
 * other to "avoid duplication": the duplication IS the control.
 */

/** Version tag written alongside the hash, so the rule can change later
 *  without silently invalidating every anchor made under the old one. */
export const HASH_VERSION = 1;

// TODO: implement. Canonical JSON: keys sorted lexicographically at every
// level, no insignificant whitespace, UTF-8, then SHA-256, then lowercase hex.
// Document the exact rule in the README before implementing it here.
export function canonicalize(_receipt: unknown): string {
  throw new Error("not implemented");
}

export function hashReceipt(_receipt: unknown): string {
  throw new Error("not implemented");
}
