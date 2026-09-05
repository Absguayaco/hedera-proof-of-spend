/**
 * The runnable end-to-end demo — the piece that makes every claim in the
 * submission reproducible instead of merely asserted.
 *
 * Clone the repo, set two environment variables, run one script. It
 * authenticates to the hosted ledger with a well-known PUBLIC demo token, so
 * nothing private is required to reproduce any of this.
 *
 * Step 6 is the one that matters: it is the only step whose evidence does not
 * come from us.
 */
export {}; // module scope — without this, `main` would collide with the verifier CLI

// TODO: implement the seven steps.
//
//   1. check_budget            — the agent asks whether it may spend
//   2. buy                     — request the resource, get a 402, pay in HBAR
//   3. file                    — the settled purchase is filed on rail "hedera"
//   4. anchor                  — hash that receipt, submit the hash to HCS
//   5. verify                  — the verifier re-hashes independently and agrees
//   6. HashScan                — the same message, on a network neither of us controls
//   7. cross-rail total        — spend across x402, MPP and Hedera in one answer
//
// Step 7 only shows three rails if the shared demo account already holds x402
// and MPP receipts. That is a seeding task, not a build task, and it is on the
// critical path. If the account will not be seeded, CUT step 7 rather than
// print a one-rail total and call it cross-rail.

async function main(): Promise<void> {
  throw new Error("not implemented");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
