/**
 * Standalone entry point: `npm run buy -- [slug]`
 *
 * Buys one item from the store by hand and prints what happened. No budget
 * check, no receipt filing, no anchoring — those belong to the larger e2e
 * walkthrough. This exists so a real purchase can be exercised and verified
 * on its own, against either the hosted store or a local one.
 */
import { assertTestnet, buyResource, hashscanUrl } from "./index.ts";

const DEFAULT_STORE_URL = "https://hedera-proof-of-spend-store.vercel.app";
const DEFAULT_SLUG = "espresso";
const TINYBAR_PER_HBAR = 100_000_000n;

/**
 * Duplicated from packages/store/src/menu.ts#formatHbar deliberately: the
 * buyer has no dependency on the store package, and this is a five-line
 * display helper, not shared logic worth a dependency for. Amounts paid are
 * always non-negative, so the negative-sign handling in the store's version
 * is not needed here.
 */
function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = tinybar % TINYBAR_PER_HBAR;
  const fractionDigits = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  return fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : `${whole}`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value;
}

function storeUrl(): string {
  const configured = process.env.STORE_URL?.trim();
  return (configured || DEFAULT_STORE_URL).replace(/\/$/, "");
}

async function main(): Promise<void> {
  const slug = process.argv[2] ?? DEFAULT_SLUG;
  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorKey = requireEnv("HEDERA_OPERATOR_KEY");

  assertTestnet(process.env.HEDERA_NETWORK);

  console.log("note: no budget check, no anchor -- use npm run e2e for the authorised, audited path.");

  const result = await buyResource({
    url: `${storeUrl()}/buy/${slug}`,
    operatorId,
    operatorKey,
  });

  console.log(`bought: ${slug}`);
  console.log(`paid: ${formatHbar(result.amountTinybar)} HBAR`);
  console.log(`transaction: ${result.settlement.transactionId}`);
  console.log(`hashscan: ${hashscanUrl(result.settlement)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
