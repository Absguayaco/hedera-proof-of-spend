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

import type { BuyResult } from "@proof-of-spend/buyer";
import type { BudgetCheckRequest } from "./decide-and-buy.ts";
import type { CheckBudgetPurchase, DescribePurchase } from "./check-budget-live.ts";

const TINYBAR_PER_HBAR = 100_000_000n;
const MERCHANT = "hedera-proof-of-spend store";

/**
 * Converts a tinybar price to the nominal USD amount check_budget's
 * `amount` field requires, using a DELIBERATELY FABRICATED, DISCLOSED
 * conversion rate: 1 HBAR = $1.00 (nominal, for demo legibility only —
 * NOT a real market rate; a real HBAR/USD rate is some awkward fraction
 * of a cent and would misleadingly look like real price-feed data). This
 * lets a judge read priceTinybar straight off packages/store/src/menu.ts
 * and predict the amount check_budget will see: espresso 15_000_000n ->
 * $0.15, flat-white 25_000_000n -> $0.25, cold-brew 35_000_000n -> $0.35.
 */
export function tinybarToNominalUsd(priceTinybar: bigint): number {
  if (priceTinybar <= 0n) {
    throw new Error(`Cannot price a non-positive tinybar amount for check_budget: ${priceTinybar}`);
  }
  // Safe as a bigint->Number conversion at this demo's scale (menu prices
  // top out at 35_000_000n, five orders of magnitude under
  // Number.MAX_SAFE_INTEGER) -- unlike packages/store/src/menu.ts's own
  // formatHbar, which must stay in bigint arithmetic for real HBAR supply.
  return Number(priceTinybar) / Number(TINYBAR_PER_HBAR);
}

export interface MenuItemPrice {
  readonly slug: string;
  readonly name: string;
  readonly priceTinybar: bigint;
}

/**
 * Fetches the store's public, unauthenticated GET /menu (packages/store's
 * menuPayload()) and parses it into a slug-keyed price map. Fetched live
 * rather than duplicating packages/store/src/menu.ts's three prices as a
 * second copy here: scripts/e2e.ts is a top-level script, not a workspace
 * package, and the buyer side of this project only ever talks to the store
 * over HTTP (see README: "packages/buyer speaks exactly one rail ... no
 * funding seam, nothing pluggable") -- importing the seller's internals
 * directly would be exactly that kind of inappropriate coupling, and a
 * hardcoded second copy could silently drift from the real menu.
 */
export async function fetchMenu(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, MenuItemPrice>> {
  const response = await fetchImpl(`${baseUrl}/menu`);
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/menu returned ${response.status}; cannot price any item.`);
  }
  const payload = (await response.json()) as { items?: unknown };
  if (!Array.isArray(payload.items)) {
    throw new Error(
      `GET ${baseUrl}/menu returned 200 but no items[] array: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  const menu = new Map<string, MenuItemPrice>();
  for (const raw of payload.items as Array<Record<string, unknown>>) {
    if (
      typeof raw.slug !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.priceTinybar !== "string"
    ) {
      throw new Error(`GET ${baseUrl}/menu returned a malformed item: ${JSON.stringify(raw)}`);
    }
    menu.set(raw.slug, { slug: raw.slug, name: raw.name, priceTinybar: BigInt(raw.priceTinybar) });
  }
  return menu;
}

/** Pulls the menu slug out of a `<storeUrl>/buy/<slug>` resource URL. */
export function slugFromResource(resource: string): string {
  const slug = new URL(resource).pathname.split("/").filter(Boolean).pop();
  if (!slug) {
    throw new Error(`Cannot determine a menu slug from resource URL "${resource}".`);
  }
  return slug;
}

/**
 * Builds the DescribePurchase createLiveCheckBudget() needs. DescribePurchase
 * is synchronous (see check-budget-live.ts), so the menu must already be
 * fetched by the time this closure is built -- it never awaits a network
 * call itself, it only looks up the pre-fetched `menu` map.
 */
export function buildDescribePurchase(menu: ReadonlyMap<string, MenuItemPrice>): DescribePurchase {
  return (request: BudgetCheckRequest): CheckBudgetPurchase => {
    const slug = slugFromResource(request.resource);
    const item = menu.get(slug);
    if (!item) {
      throw new Error(
        `No menu item for slug "${slug}" (from resource "${request.resource}"). ` +
          `Known slugs: ${Array.from(menu.keys()).join(", ") || "(none -- GET /menu returned no items)"}.`,
      );
    }
    return {
      amount: tinybarToNominalUsd(item.priceTinybar),
      currency: "USD",
      merchant: MERCHANT,
      description: `${item.name} -- ${item.priceTinybar.toString()} tinybar (nominal 1 HBAR = $1.00 demo rate)`,
    };
  };
}

/**
 * The receipt object steps 3-4 file and anchor. Shape follows the README's
 * own worked example ({rail, amount, item}) plus settlement detail, and its
 * own hash-spec rules: amounts and Hedera's validStartSeconds/validStartNanos
 * (numbers on HederaSettlement) travel as decimal STRINGS, never JS numbers
 * -- packages/anchor/src/hash.ts's canonicalize() rejects numbers outright.
 * Keys need not be pre-sorted; the hasher sorts them (rule 3).
 */
export function buildReceipt(slug: string, purchase: BuyResult): Record<string, unknown> {
  return {
    rail: "hedera",
    item: { slug },
    amountTinybar: purchase.amountTinybar.toString(),
    settlement: {
      transactionId: purchase.settlement.transactionId,
      feePayer: purchase.settlement.feePayer,
      validStartSeconds: String(purchase.settlement.validStartSeconds),
      validStartNanos: String(purchase.settlement.validStartNanos),
    },
  };
}

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
//
// Steps 1-2 are expected to be implemented via decideAndBuy()
// (scripts/decide-and-buy.ts), which anchors the budget decision to HCS
// before payment executes, rather than treating check_budget and buy as
// independent, sequential steps.

async function main(): Promise<void> {
  throw new Error("not implemented");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
