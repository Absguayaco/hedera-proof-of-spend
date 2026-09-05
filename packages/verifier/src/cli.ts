/**
 * Standalone entry point: `npm run verify -- --receipt ./receipt.json`
 *
 * Deliberately runnable on its own, with no credentials. Reading the topic
 * needs a public mirror node and nothing else — which is what makes this the
 * one step in the walkthrough whose evidence does not come from us.
 */
import { verify } from "./index.ts";

void verify; // referenced once implemented

// TODO: implement — parse args, read the receipt JSON, call verify(),
// print the outcome and the HashScan link, exit non-zero on missing/altered.
async function main(): Promise<void> {
  throw new Error("not implemented");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
