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
 */
export function hashscanUrl(settlement: HederaSettlement): string {
  return `https://hashscan.io/testnet/transaction/${settlement.feePayer}-${settlement.validStartSeconds}-${settlement.validStartNanos}`;
}
