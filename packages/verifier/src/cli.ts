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
 * Trusting a receipt-supplied topic id is safe only because
 * packages/anchor's anchorReceipt() now refuses to write to a topic it
 * doesn't own (see assertTopicOwnership()) -- before that, defaulting to
 * whatever a receipt claims would have let anyone point this at a topic
 * they control and self-verify. This function does not re-check
 * ownership itself: that already happened, once, on the anchor side, and
 * HCS's own consensus rules are what make every message on an owned topic
 * transitively trustworthy from here on (see this plan's Context section).
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
  console.log(
    `topic: ${topicId}` +
      (explicitTopicId ? "" : " (from the receipt's own decision.topicId reference)"),
  );

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
