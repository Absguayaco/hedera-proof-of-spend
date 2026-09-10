/**
 * Hedera does not identify a settled transaction with an EVM transaction hash.
 * It uses a transaction ID: the paying account, then a valid-start time.
 *
 *     0.0.<feePayer>@<seconds>.<nanos>
 *
 * Anything that assumes an 0x-prefixed 32-byte hash will silently mis-store
 * this, which is why parsing lives in its own file with its own tests.
 */
export interface HederaSettlement {
  /** The full transaction ID, exactly as the facilitator reported it. */
  readonly transactionId: string;
  /** Account that paid the fee, e.g. "0.0.12345". */
  readonly feePayer: string;
  /**
   * The transaction's valid-start time, split as encoded in the transaction
   * ID — chosen by the paying client, NOT the network. This is NOT the
   * consensus timestamp; a real consensus timestamp can only come from the
   * mirror node (its `consensus_timestamp` field), and can differ from this
   * by several seconds.
   */
  readonly validStartSeconds: number;
  readonly validStartNanos: number;
}

const TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

// Reject anything not matching TX_ID rather than coercing — a malformed
// settlement reference must fail loudly, not file a bad receipt.
export function parseSettlement(raw: string): HederaSettlement {
  const match = TX_ID.exec(raw);
  if (!match) {
    throw new Error(
      `Not a Hedera transaction id (got "${raw}"). Expected payer@seconds.nanos, ` +
        `e.g. 0.0.12345@1699999999.123456789.`,
    );
  }
  const [, feePayer, seconds, nanos] = match;
  return {
    transactionId: raw,
    feePayer,
    validStartSeconds: Number(seconds),
    validStartNanos: Number(nanos),
  };
}

/**
 * HashScan URL for a transaction, so a receipt can link to third-party proof.
 *
 * Verified live: https://hashscan.io/testnet/tx/<transactionId> (dots, word
 * "tx") renders every field as "None" -- broken. HashScan actually expects
 * https://hashscan.io/testnet/transaction/<feePayer>-<seconds>-<nanos>
 * (dashes, word "transaction"). Built from the already-parsed fields, not by
 * string-replacing dots in transactionId, which would also mangle the dots
 * inside the shard.realm.num fee-payer account id.
 *
 * `validStartNanos` is a fixed-width 9-digit field of the transaction id
 * (see TX_ID above), but `HederaSettlement` stores it as a `number` --
 * `Number("003987758")` is the correct value `3987758`, but re-embedding
 * that number directly into the URL silently drops its significant leading
 * zeros, producing a shorter, WRONG dash-separated id that 404s on HashScan.
 * Re-padded to 9 digits here, right before it re-enters a string context,
 * rather than changing `validStartNanos`'s type: this is the one place a
 * dropped leading zero actually matters, and every other consumer of this
 * field (this package's own tests, `scripts/e2e.ts`'s receipt-building)
 * only ever needs the numeric value, never this exact zero-padded spelling.
 * Roughly one real transaction in ten has a nanos component starting with
 * "0", so this was silently wrong often enough to matter, not a rare edge
 * case -- confirmed against a real testnet transaction:
 * 0.0.7162784@1788825896.003987758 must produce
 * .../0.0.7162784-1788825896-003987758, not .../0.0.7162784-1788825896-3987758.
 */
export function hashscanUrl(settlement: HederaSettlement): string {
  const nanos = String(settlement.validStartNanos).padStart(9, "0");
  return `https://hashscan.io/testnet/transaction/${settlement.feePayer}-${settlement.validStartSeconds}-${nanos}`;
}
