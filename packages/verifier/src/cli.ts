/**
 * Standalone entry point: `npm run verify -- --receipt ./receipt.json`
 *
 * Deliberately runnable on its own, with no credentials. Reading the topic
 * needs a public mirror node and nothing else — which is what makes this the
 * one step in the walkthrough whose evidence does not come from us.
 */
import { readFile } from "node:fs/promises";
import { verify } from "./index.ts";

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
        "knew to be this agent's topic. A \"match\" below proves the hash sits on a topic " +
        "SOMEONE owns -- not that THIS agent anchored it. Pass --topic <the agent's known " +
        "topic id> for a check that actually binds the result to a specific agent.",
    );
  }

  const result = await verify(receipt, { topicId, network });

  console.log(`outcome: ${result.outcome}`);
  console.log(`computed hash: ${result.computedHash}`);
  if (result.consensusTimestamp) console.log(`consensus timestamp: ${result.consensusTimestamp}`);
  if (result.hashscanUrl) console.log(`hashscan: ${result.hashscanUrl}`);

  if (result.outcome !== "match") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
