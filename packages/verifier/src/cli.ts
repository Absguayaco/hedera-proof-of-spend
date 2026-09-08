/**
 * Standalone entry point: `npm run verify -- --receipt ./receipt.json`
 *
 * Deliberately runnable on its own, with no credentials. Reading the topic
 * needs a public mirror node and nothing else — which is what makes this the
 * one step in the walkthrough whose evidence does not come from us.
 */
import { readFile } from "node:fs/promises";
import { verify } from "./index.ts";

/** The topic this demo anchors to when HCS_TOPIC_ID isn't set — created
 *  during development (see docs/superpowers/plans/2026-09-08-anchoring.md,
 *  Task 5), so `npm run verify -- --receipt ./receipt.json` works exactly as
 *  README documents, with zero setup. Override with --topic or HCS_TOPIC_ID
 *  to check a different topic. */
const DEFAULT_TOPIC_ID = "0.0.10424108";

interface Args {
  readonly receiptPath: string;
  readonly topicId: string;
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
    topicId: topicId || env.HCS_TOPIC_ID?.trim() || DEFAULT_TOPIC_ID,
    network: network || env.HEDERA_NETWORK?.trim() || undefined,
  };
}

async function main(): Promise<void> {
  const { receiptPath, topicId, network } = parseArgs(process.argv.slice(2), process.env);

  const raw = await readFile(receiptPath, "utf8");
  const receipt: unknown = JSON.parse(raw);

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
