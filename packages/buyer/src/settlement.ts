/**
 * Hedera does not identify a settled transaction with an EVM transaction hash.
 * It uses a transaction ID: the paying account, then the consensus timestamp.
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
  /** Consensus timestamp, split as Hedera reports it. */
  readonly seconds: number;
  readonly nanos: number;
}

const TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

// TODO: implement. Reject anything not matching TX_ID rather than coercing —
// a malformed settlement reference must fail loudly, not file a bad receipt.
export function parseSettlement(_raw: string): HederaSettlement {
  throw new Error("not implemented");
}

/** HashScan URL for a transaction, so a receipt can link to third-party proof. */
export function hashscanUrl(_settlement: HederaSettlement): string {
  throw new Error("not implemented");
}
