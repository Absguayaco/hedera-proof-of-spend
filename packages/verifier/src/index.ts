import { hashReceipt } from "./hash.ts";

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
  /** The anchoring message's position in the topic's own ordered log, read
   *  straight from the mirror node. Present only on a "match". A plain JSON
   *  number, NOT the same representation as its counterpart:
   *  packages/anchor's AnchorResult.sequenceNumber and
   *  scripts/decide-and-buy.ts's DecisionReceiptRef.sequenceNumber are both
   *  decimal STRINGS (the SDK's `Long`, converted). Comparing this field
   *  against either of those with `===` always returns false, even on a true
   *  match ("42" === 42 is false) -- use the sequenceNumbersMatch() helper
   *  below instead of writing that comparison at a call site. */
  readonly sequenceNumber?: number;
  /** Link to the same message on HashScan, on a network neither party controls. */
  readonly hashscanUrl?: string;
}

/** Confirmed live (2026-09-08): the mirror node's public REST base URLs. Not
 *  imported from @x402/hedera on purpose — see this package's package.json:
 *  the dependency list is the claim. */
const MIRROR_NODE_URL: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

/** Validates `network` and returns its mirror-node base URL. Shared by every
 *  function in this file that reads from the mirror node -- verify() and
 *  fetchSettlementConsensusTimestamp(). Object.hasOwn guards against
 *  inherited Object.prototype members ("toString", "constructor",
 *  "valueOf", ...) being read back as a truthy "known network" when
 *  network comes straight from --network / env. */
function mirrorBaseUrl(network: string): string {
  if (!Object.hasOwn(MIRROR_NODE_URL, network)) {
    throw new Error(`Unsupported network "${network}". Expected "testnet" or "mainnet".`);
  }
  return MIRROR_NODE_URL[network];
}

interface MirrorMessage {
  readonly message: string; // base64
  readonly consensus_timestamp: string;
  /** The message's position in the topic's own ordered log. Confirmed live
   *  against the real mirror node that this field is present on every entry
   *  as a plain JSON number -- unlike the SDK-side
   *  TransactionReceipt.topicSequenceNumber, which is a `Long`. */
  readonly sequence_number: number;
}

interface MirrorMessagesPage {
  readonly messages: readonly MirrorMessage[];
  readonly links: { readonly next: string | null };
}

export async function verify(
  receipt: unknown,
  opts: { topicId: string; network?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const computedHash = hashReceipt(receipt);
  const network = opts.network ?? "testnet";
  const base = mirrorBaseUrl(network);

  let path: string | null = `/api/v1/topics/${opts.topicId}/messages?limit=100`;
  while (path) {
    const response = await fetchImpl(`${base}${path}`);
    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for topic ${opts.topicId}. ` +
          `Check the topic id and network.`,
      );
    }
    const parsedPage = (await response.json()) as Partial<MirrorMessagesPage>;
    if (!Array.isArray(parsedPage?.messages)) {
      throw new Error(
        `Mirror node returned 200 but not a topic-messages page for topic ` +
          `${opts.topicId} on ${network}. Got: ${JSON.stringify(parsedPage).slice(0, 200)}`,
      );
    }

    for (const entry of parsedPage.messages) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(entry.message, "base64").toString("utf8"));
        if (
          decoded !== null &&
          typeof decoded === "object" &&
          (decoded as { h?: unknown }).h === computedHash
        ) {
          return {
            outcome: "match",
            computedHash,
            consensusTimestamp: entry.consensus_timestamp,
            sequenceNumber: entry.sequence_number,
            hashscanUrl: `https://hashscan.io/${network}/topic/${opts.topicId}/messages`,
          };
        }
      } catch {
        // not our JSON shape — skip rather than fail the whole scan
      }
    }

    // links.next is a relative path, not an absolute URL — confirmed live.
    // Optional chaining in case links itself is missing from a malformed page.
    path = parsedPage.links?.next ?? null;
  }

  // A hash with no matching message could mean "never anchored" or "anchored
  // for a different version of this receipt, now altered" — but AnchorMessage
  // carries only {v, h}, no receipt id or other correlator (a deliberate
  // privacy choice: "the topic alone tells an observer nothing"). Without a
  // correlator those two cases are indistinguishable from a topic scan, so
  // "altered" is not reachable here; every non-match reports "missing".
  return { outcome: "missing", computedHash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SETTLEMENT_MAX_ATTEMPTS = 6;
const SETTLEMENT_RETRY_DELAY_MS = 5_000;

// Same shape as packages/buyer/src/settlement.ts's TX_ID -- deliberately
// duplicated rather than imported: packages/verifier must depend on nothing
// of ours (see this package's package.json and scripts/check-verifier-independence.mjs),
// and importing @proof-of-spend/buyer here would be exactly the kind of
// workspace dependency that guard exists to catch.
const SETTLEMENT_TRANSACTION_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

/**
 * The mirror node's /transactions endpoint requires the DASH form
 * (shard.realm.num-seconds-nanos), confirmed live -- the @/dot form this
 * repo's own HederaSettlement.transactionId uses (payer@seconds.nanos) is
 * rejected with HTTP 400. Built from the parsed match groups, never by
 * string-replacing the dot/@ form (which would also mangle the dots inside
 * the fee-payer's own shard.realm.num account id) -- same reasoning as
 * packages/buyer/src/settlement.ts's hashscanUrl().
 */
function toDashTransactionId(raw: string): string {
  const match = SETTLEMENT_TRANSACTION_ID.exec(raw);
  if (!match) {
    throw new Error(
      `Not a Hedera transaction id (got "${raw}"). Expected payer@seconds.nanos, ` +
        `e.g. 0.0.12345@1699999999.123456789 -- the same shape ` +
        `packages/buyer/src/settlement.ts's HederaSettlement.transactionId produces.`,
    );
  }
  const [, feePayer, seconds, nanos] = match;
  return `${feePayer}-${seconds}-${nanos}`;
}

interface MirrorTransaction {
  readonly consensus_timestamp: string;
  readonly result: string;
}

interface MirrorTransactionsPage {
  readonly transactions: readonly MirrorTransaction[];
}

export interface SettlementConsensusResult {
  readonly found: boolean;
  readonly transactionId: string;
  readonly consensusTimestamp?: string;
  readonly result?: string;
}

/**
 * Looks up a settled Hedera payment's REAL consensus timestamp from the
 * public mirror node -- distinct from, and often several seconds later
 * than, the transaction's own valid-start time (HederaSettlement.validStartSeconds/
 * Nanos, chosen by the paying client, not the network).
 *
 * A genuinely nonexistent transaction and one that simply hasn't been
 * ingested by the mirror node yet both return HTTP 404 -- indistinguishable
 * from a single lookup, and the ingestion lag is the same order of magnitude
 * as this repo's own already-measured HCS-to-mirror-node lag (~8.68s on a
 * real transaction). So a 404 is retried (same 6-attempts/5s-apart shape as
 * scripts/e2e.ts's existing topic-message retry loop) before being treated
 * as "does not exist".
 */
export async function fetchSettlementConsensusTimestamp(
  transactionId: string,
  opts: { network?: string } = {},
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<SettlementConsensusResult> {
  const network = opts.network ?? "testnet";
  const base = mirrorBaseUrl(network);
  const dashId = toDashTransactionId(transactionId);
  const url = `${base}/api/v1/transactions/${dashId}`;

  for (let attempt = 1; attempt <= SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(url);

    if (response.status === 404) {
      if (attempt < SETTLEMENT_MAX_ATTEMPTS) {
        await sleepImpl(SETTLEMENT_RETRY_DELAY_MS);
        continue;
      }
      return { found: false, transactionId };
    }

    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for transaction ${transactionId} ` +
          `(${dashId}). Check the transaction id and network.`,
      );
    }

    const parsed = (await response.json()) as Partial<MirrorTransactionsPage>;
    if (!Array.isArray(parsed?.transactions)) {
      throw new Error(
        `Mirror node returned 200 but not a transactions page for ${transactionId} ` +
          `(${dashId}) on ${network}. Got: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }

    const [first] = parsed.transactions;
    if (!first) {
      if (attempt < SETTLEMENT_MAX_ATTEMPTS) {
        await sleepImpl(SETTLEMENT_RETRY_DELAY_MS);
        continue;
      }
      return { found: false, transactionId };
    }

    return {
      found: true,
      transactionId,
      consensusTimestamp: first.consensus_timestamp,
      result: first.result,
    };
  }

  // Unreachable: the loop above always returns before exhausting its own
  // bound. Present only so TypeScript sees every path returning.
  return { found: false, transactionId };
}

export type OrderingOutcome =
  | "decision_before_settlement"
  | "decision_not_before_settlement"
  | "decision_not_anchored"
  | "settlement_not_found"
  | "settlement_failed";

export interface OrderingProofResult {
  readonly outcome: OrderingOutcome;
  readonly settlementTransactionId: string;
  readonly decisionConsensusTimestamp?: string;
  readonly settlementConsensusTimestamp?: string;
}

const CONSENSUS_TIMESTAMP = /^(\d+)\.(\d+)$/;

/** Converts a mirror-node "seconds.nanoseconds" consensus timestamp into a
 *  single BigInt of nanoseconds, so two timestamps can be compared exactly.
 *  Lexicographic string comparison is NOT safe here: nothing guarantees the
 *  two timestamps being compared have the same digit count, and the seconds
 *  component will eventually grow an extra digit (Hedera's mainnet launched
 *  in 2019 with 10-digit Unix seconds; that stays 10 digits until the year
 *  2286, but is not a safe assumption to bake in silently). */
function timestampToNanos(timestamp: string): bigint {
  const match = CONSENSUS_TIMESTAMP.exec(timestamp);
  if (!match) {
    throw new Error(
      `Not a mirror-node consensus timestamp (got "${timestamp}"). Expected "seconds.nanoseconds".`,
    );
  }
  const [, seconds, nanos] = match;
  if (nanos.length > 9) {
    throw new Error(
      `Not a mirror-node consensus timestamp (got "${timestamp}"): nanoseconds component ` +
        `has more than 9 digits.`,
    );
  }
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0"));
}

/**
 * The A2/A3/A6/A7 ordering proof: given the decision anchor's own VerifyResult
 * (from verify(), already reconciled against the mirror node) and the Hedera
 * transaction id the payment settled under, reports whether the decision's
 * anchor genuinely reached HCS consensus strictly before the payment
 * settled -- checkable by a third party from public data alone, with no
 * trust in the agent's own code sequencing required. This is what
 * scripts/decide-and-buy.ts's "decision anchored before payment" ordering
 * was, until now, enforced only by its own code sequencing to guarantee --
 * this function is the independent, public check for it.
 *
 * A Hedera transaction that FAILS (e.g. INSUFFICIENT_PAYER_BALANCE) still
 * reaches consensus and still gets a real consensus_timestamp -- reaching
 * consensus is not the same as the payment settling. So before comparing
 * timestamps, this checks the settlement's own reported `result`: anything
 * other than "SUCCESS" short-circuits to the "settlement_failed" outcome
 * rather than computing (and misreporting) an ordering.
 *
 * Can throw rather than resolve to an outcome: a malformed
 * settlementTransactionId, a non-404 mirror-node error status, or a 200
 * response that isn't shaped like a transactions page (all from the
 * underlying fetchSettlementConsensusTimestamp() lookup), or a malformed
 * consensus_timestamp string on either the decision or the settlement side.
 */
export async function verifyDecisionPrecedesSettlement(
  decisionVerify: VerifyResult,
  settlementTransactionId: string,
  opts: { network?: string } = {},
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<OrderingProofResult> {
  if (decisionVerify.outcome !== "match" || decisionVerify.consensusTimestamp === undefined) {
    return { outcome: "decision_not_anchored", settlementTransactionId };
  }

  const settlement = await fetchSettlementConsensusTimestamp(
    settlementTransactionId,
    opts,
    fetchImpl,
    sleepImpl,
  );

  if (!settlement.found || settlement.consensusTimestamp === undefined) {
    return {
      outcome: "settlement_not_found",
      settlementTransactionId,
      decisionConsensusTimestamp: decisionVerify.consensusTimestamp,
    };
  }

  if (settlement.result !== "SUCCESS") {
    // Reached consensus but FAILED (e.g. INSUFFICIENT_PAYER_BALANCE) -- not
    // the same as the payment settling, so no ordering claim is made. Both
    // timestamps are already known and are included for a caller to display,
    // even though "before/after" isn't a meaningful question here.
    return {
      outcome: "settlement_failed",
      settlementTransactionId,
      decisionConsensusTimestamp: decisionVerify.consensusTimestamp,
      settlementConsensusTimestamp: settlement.consensusTimestamp,
    };
  }

  const decisionNanos = timestampToNanos(decisionVerify.consensusTimestamp);
  const settlementNanos = timestampToNanos(settlement.consensusTimestamp);

  return {
    outcome:
      decisionNanos < settlementNanos
        ? "decision_before_settlement"
        : "decision_not_before_settlement",
    settlementTransactionId,
    decisionConsensusTimestamp: decisionVerify.consensusTimestamp,
    settlementConsensusTimestamp: settlement.consensusTimestamp,
  };
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";

/**
 * The one place packages/anchor's decimal-string sequenceNumber (the SDK's
 * `Long`, converted -- AnchorResult.sequenceNumber,
 * scripts/decide-and-buy.ts's DecisionReceiptRef.sequenceNumber) and this
 * package's plain-number sequenceNumber (VerifyResult.sequenceNumber, read
 * straight off the mirror node's JSON) need to be reconciled. A naive
 * `===` between them is always false, even for a true match, because
 * `"42" === 42` is false in JavaScript -- this closes that gap once, here,
 * instead of at every future call site that wires the two together. Either
 * side being `undefined` is NOT a match: two unrelated "we don't know" values
 * are not evidence of agreement.
 */
export function sequenceNumbersMatch(
  verifySequenceNumber: number | undefined,
  referenceSequenceNumber: string | undefined,
): boolean {
  if (verifySequenceNumber === undefined || referenceSequenceNumber === undefined) {
    return false;
  }
  return String(verifySequenceNumber) === referenceSequenceNumber;
}
