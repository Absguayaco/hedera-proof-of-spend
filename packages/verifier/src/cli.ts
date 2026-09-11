/**
 * Standalone entry point: `npm run verify -- --receipt ./receipt.json`
 *
 * Deliberately runnable on its own, with no credentials. Reading the topic
 * needs a public mirror node and nothing else — which is what makes this the
 * one step in the walkthrough whose evidence does not come from us.
 */
import { readFile } from "node:fs/promises";
import { verify, verifyAtSequence, verifyDecisionPrecedesSettlement } from "./index.ts";
import type { Outcome, OrderingProofResult, VerifyResult } from "./index.ts";

interface Args {
  readonly receiptPath: string;
  /** Absent unless --topic or HCS_TOPIC_ID was explicitly given -- an
   *  absent value means "fall back to whatever the receipt itself names",
   *  resolved later by resolveTopicId() once the receipt has been read. */
  readonly topicId: string | undefined;
  readonly network?: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  let receiptPath: string | undefined;
  let topicId: string | undefined;
  let network: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--receipt") receiptPath = argv[(i += 1)];
    else if (flag === "--topic") topicId = argv[(i += 1)];
    else if (flag === "--network") network = argv[(i += 1)];
  }

  if (!receiptPath) {
    throw new Error(
      "Missing --receipt <path>. Usage: npm run verify -- --receipt ./receipt.json",
    );
  }

  return {
    receiptPath,
    topicId: topicId || env.HCS_TOPIC_ID?.trim() || undefined,
    network: network || env.HEDERA_NETWORK?.trim() || undefined,
  };
}

/**
 * Determines which topic to check. An explicit --topic/HCS_TOPIC_ID always
 * wins; otherwise falls back to the topic the receipt itself names, via the
 * structured {nonce, topicId, sequenceNumber} reference
 * linkReceiptToDecision() embeds (see scripts/decide-and-buy.ts).
 *
 * WHAT THE RECEIPT-SUPPLIED FALLBACK DOES AND DOES NOT PROVE. Reusing a
 * caller-supplied topic id is safe on the ANCHOR side, now that
 * packages/anchor's anchorReceipt() refuses to write to a topic it doesn't
 * own (see assertTopicOwnership()) -- an agent can no longer be made to
 * anchor into a topic it doesn't control. But that does NOT mean a
 * "match" against a topic id taken FROM THE RECEIPT proves the receipt
 * came from any particular agent. Anyone can run createTopic() with THEIR
 * OWN key, legitimately own the result, anchor a fabricated receipt's hash
 * there, and hand you that receipt with its own decision.topicId pointing
 * at their topic -- assertTopicOwnership() passes for them (it's genuinely
 * their topic), resolveTopicId() reads their receipt's own claim, and
 * verify() reports "match". A "match" reached this way proves only "this
 * hash sits on SOME topic that SOMEONE owns" -- not "this agent anchored
 * it". Proving the latter needs knowing, independently of the receipt
 * itself, which topic id belongs to the agent being checked (e.g. an
 * explicit --topic the caller already trusts) -- this repo does not yet
 * publish that binding anywhere a third party could look it up, and this
 * function makes no attempt to. Passing an explicit --topic you already
 * know to be the agent's is the only way this tool's "match" carries that
 * meaning; main() prints a caveat below whenever the topic id instead came
 * from the receipt's own claim, for exactly this reason.
 *
 * No hardcoded default topic: a shared fallback is exactly the
 * world-writable-by-design shape this whole fix closes. If neither an
 * explicit topic id nor a receipt-carried one is available, this throws
 * rather than guessing.
 */
export function resolveTopicId(explicit: string | undefined, receipt: unknown): string {
  if (explicit) {
    return explicit;
  }
  if (receipt !== null && typeof receipt === "object" && "decision" in receipt) {
    const decision = (receipt as { decision: unknown }).decision;
    if (
      decision !== null &&
      typeof decision === "object" &&
      "topicId" in decision &&
      typeof (decision as { topicId: unknown }).topicId === "string" &&
      (decision as { topicId: string }).topicId
    ) {
      return (decision as { topicId: string }).topicId;
    }
  }
  throw new Error(
    "No topic id available: pass --topic, set HCS_TOPIC_ID, or use a receipt that carries a " +
      "decision.topicId reference (see scripts/decide-and-buy.ts's linkReceiptToDecision()).",
  );
}

/** What `main()` needs to run the ordering proof: the full authorizing
 *  Decision (the preimage a third party needs to re-hash), the exact topic
 *  position it was anchored at, and the settlement transaction id it must
 *  precede. Returns undefined -- not a throw -- when the receipt doesn't
 *  carry this shape: "cannot check ordering" is a legitimate, disclosed
 *  outcome for an older or hand-authored receipt, not an error. */
export interface DecisionReference {
  readonly authorizingDecision: unknown;
  readonly topicId: string;
  readonly sequenceNumber: string;
  readonly settlementTransactionId: string;
}

export function extractDecisionReference(receipt: unknown): DecisionReference | undefined {
  if (receipt === null || typeof receipt !== "object") return undefined;
  const r = receipt as Record<string, unknown>;

  // authorizingDecision itself has no fixed shape here (it's re-hashed
  // whole by verifyAtSequence(), which will correctly report "altered" for
  // any value that doesn't match what was actually anchored) -- but it
  // must genuinely be present and non-null, not merely an own key whose
  // value happens to be undefined/null.
  if (r.authorizingDecision === undefined || r.authorizingDecision === null) {
    return undefined;
  }

  const decision = r.decision;
  if (decision === null || typeof decision !== "object") return undefined;
  const decisionRecord = decision as Record<string, unknown>;
  const topicId = decisionRecord.topicId;
  const sequenceNumber = decisionRecord.sequenceNumber;
  if (typeof topicId !== "string" || typeof sequenceNumber !== "string") return undefined;

  const settlement = r.settlement;
  if (settlement === null || typeof settlement !== "object") return undefined;
  const settlementTransactionId = (settlement as Record<string, unknown>).transactionId;
  if (typeof settlementTransactionId !== "string") return undefined;

  return {
    authorizingDecision: r.authorizingDecision,
    topicId,
    sequenceNumber,
    settlementTransactionId,
  };
}

/**
 * The pass/fail contract this whole tool exists to enforce, pulled out as
 * a pure function so it is directly testable without executing main()'s
 * file I/O and network calls. Requires the receipt's own hash to match,
 * AND -- only when the receipt actually carries an ordering reference --
 * that the decision's own anchor matched AND that it genuinely preceded
 * settlement. A receipt with no ordering reference at all still passes on
 * hash alone (matching this repo's plan-mandated formula: "core proof
 * succeeded, ordering not checked" is a legitimate, disclosed outcome, not
 * a failure) -- but ANY of "altered", "missing", or a non-"decision_before_
 * settlement" ordering outcome, once a reference IS present, is a failure.
 */
export function classifyRun(
  receiptOutcome: Outcome,
  hasReference: boolean,
  decisionOutcome: Outcome | undefined,
  orderingOutcome: OrderingProofResult["outcome"] | undefined,
): boolean {
  return (
    receiptOutcome === "match" &&
    (!hasReference ||
      (decisionOutcome === "match" && orderingOutcome === "decision_before_settlement"))
  );
}

function section(title: string): void {
  console.log("");
  console.log(`=== ${title} ===`);
}

async function main(): Promise<void> {
  const { receiptPath, topicId: explicitTopicId, network } = parseArgs(process.argv.slice(2), process.env);

  const raw = await readFile(receiptPath, "utf8");
  const receipt: unknown = JSON.parse(raw);

  const topicId = resolveTopicId(explicitTopicId, receipt);
  if (explicitTopicId) {
    console.log(`topic: ${topicId}`);
  } else {
    console.log(`topic: ${topicId} (from the receipt's own decision.topicId reference)`);
    console.log(
      "WARNING: this topic id came from the receipt itself, not from something you already " +
        'knew to be this agent\'s topic. A "match" below proves the hash sits on a topic ' +
        'SOMEONE owns -- not that THIS agent anchored it. Pass --topic <the agent\'s known ' +
        "topic id> for a check that actually binds the result to a specific agent.",
    );
  }

  const result = await verify(receipt, { topicId, network });
  console.log(`outcome: ${result.outcome}`);
  console.log(`computed hash: ${result.computedHash}`);
  if (result.consensusTimestamp) console.log(`consensus timestamp: ${result.consensusTimestamp}`);
  if (result.hashscanUrl) console.log(`hashscan: ${result.hashscanUrl}`);

  // --- Ordering proof (A2/A3/A6/A7): the same check scripts/e2e.ts already
  // proves live, run here against nothing but the receipt file and the
  // public mirror node -- this is the one command a third party actually
  // runs, so this is where the ordering claim has to hold. ---
  section("Ordering proof (A2/A3/A6/A7)");
  const reference = extractDecisionReference(receipt);
  let decisionResult: VerifyResult | undefined;
  let orderingResult: OrderingProofResult | undefined;

  if (!reference) {
    console.log(
      "Not checked: this receipt does not carry a decision/settlement reference " +
        "(authorizingDecision, decision.topicId/sequenceNumber, settlement.transactionId).",
    );
  } else {
    // Looked up on the SAME topic the hash was just checked against --
    // topicId, not necessarily reference.topicId. If --topic was given
    // specifically because the caller already trusts it as this agent's,
    // the decision anchor must be checked there too, not wherever the
    // receipt separately claims -- otherwise --topic would only bind half
    // of what this command checks.
    if (reference.topicId !== topicId) {
      console.log(
        `note: the receipt's own decision.topicId ("${reference.topicId}") differs from the ` +
          `topic actually being checked ("${topicId}") -- looking up the decision at "${topicId}".`,
      );
    }
    decisionResult = await verifyAtSequence(reference.authorizingDecision, {
      topicId,
      sequenceNumber: reference.sequenceNumber,
      network,
    });
    console.log(`decision anchor outcome: ${decisionResult.outcome}`);
    if (decisionResult.consensusTimestamp) {
      console.log(`decision consensus timestamp: ${decisionResult.consensusTimestamp}`);
    }

    orderingResult = await verifyDecisionPrecedesSettlement(
      decisionResult,
      reference.settlementTransactionId,
      { network },
    );
    console.log(`ordering outcome: ${orderingResult.outcome}`);
    if (orderingResult.decisionConsensusTimestamp) {
      console.log(`decision consensus timestamp (ordering proof): ${orderingResult.decisionConsensusTimestamp}`);
    }
    if (orderingResult.settlementConsensusTimestamp) {
      console.log(`settlement consensus timestamp: ${orderingResult.settlementConsensusTimestamp}`);
    }
  }

  const coreSuccess = classifyRun(
    result.outcome,
    reference !== undefined,
    decisionResult?.outcome,
    orderingResult?.outcome,
  );

  console.log("");
  console.log(
    coreSuccess
      ? `VERIFIED${reference ? " -- hash matched, decision anchor matched, ordering holds." : " (hash matched; ordering not checked -- see above)."}`
      : "NOT VERIFIED -- see outcomes above.",
  );

  if (!coreSuccess) {
    process.exitCode = 1;
  }
}

// Only run when this file is executed directly (`npm run verify`, or
// `node packages/verifier/src/cli.ts`) -- not when imported, e.g. by this
// file's own test suite. Same pattern as packages/store/src/index.ts's own
// run-guard.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
