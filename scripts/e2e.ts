/**
 * The runnable end-to-end demo — the piece that makes every claim in the
 * submission reproducible instead of merely asserted.
 *
 * Clone the repo, set the required environment variables (see .env.example
 * -- HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, ASKRECEIPTS_AGENT_KEY), run
 * one script.
 *
 * Steps 1-6 of the README's "Verify it yourself" walkthrough run for real,
 * live, against real testnet infrastructure: a real check_budget call, a
 * real x402 payment in HBAR, a real receipt, a real HCS anchor, a real
 * independent re-verification against a public mirror node, and real
 * HashScan links. Steps 1-2 are one decideAndBuy() call under the hood (see
 * scripts/decide-and-buy.ts's own doc comment) but are reported here as
 * two steps for narrative clarity, matching the README.
 *
 * In addition to the approval walkthrough, this also runs a live decline
 * demonstration: the same real checkBudget is asked about the priciest
 * menu item, cold-brew, which a budget rule pre-provisioned on the
 * askReceipts demo account (see docs/superpowers/plans's e2e implementation
 * plan's Prerequisite section) is expected to refuse. This is what makes
 * the decline a real, live refusal rather than a simulated one.
 *
 * Step 7 (cross-rail total) is intentionally NOT attempted. No seeding
 * infrastructure exists anywhere in this repo to put real x402/MPP
 * receipts on the shared demo account -- see docs/design.md's Open Items.
 * Printing a one-rail total and calling it "cross-rail" would misrepresent
 * what was actually checked, so this is cut, not faked, and reported as
 * such in the output rather than silently skipped.
 *
 * Step 6 is the one that matters: it is the only step whose evidence does
 * not come from us.
 */
export {}; // module scope — without this, `main` would collide with the verifier CLI

import { anchorReceipt } from "@proof-of-spend/anchor";
import { assertTestnet, hashscanUrl } from "@proof-of-spend/buyer";
import { verify } from "@proof-of-spend/verifier";
import { createLiveCheckBudget } from "./check-budget-live.ts";
import { decideAndBuy } from "./decide-and-buy.ts";
import type { DecideAndBuyResult } from "./decide-and-buy.ts";

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

const DEFAULT_STORE_URL = "https://hedera-proof-of-spend-store.vercel.app";
const DEFAULT_ASKRECEIPTS_URL = "https://www.askreceipts.com/api/mcp";
const AGENT_ID = "hedera-proof-of-spend-e2e-agent";
const APPROVAL_SLUG = "espresso";
const DECLINE_SLUG = "cold-brew";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See .env.example.`);
  }
  return value;
}

// Same convention as packages/buyer/src/cli.ts's storeUrl(): default URL,
// trailing-slash stripped.
function storeUrl(): string {
  const configured = process.env.STORE_URL?.trim();
  return (configured || DEFAULT_STORE_URL).replace(/\/$/, "");
}

function askReceiptsUrl(): string {
  const configured = process.env.ASKRECEIPTS_URL?.trim();
  return (configured || DEFAULT_ASKRECEIPTS_URL).replace(/\/$/, "");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = tinybar % TINYBAR_PER_HBAR;
  const fractionDigits = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  return fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : `${whole}`;
}

function section(title: string): void {
  console.log("");
  console.log(`=== ${title} ===`);
}

async function main(): Promise<void> {
  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorKey = requireEnv("HEDERA_OPERATOR_KEY");
  const agentKey = requireEnv("ASKRECEIPTS_AGENT_KEY");
  assertTestnet(process.env.HEDERA_NETWORK);

  const store = storeUrl();
  const ledger = askReceiptsUrl();
  const envTopicId = process.env.HCS_TOPIC_ID?.trim() || undefined;

  console.log("hedera-proof-of-spend -- end-to-end walkthrough");
  console.log(`store: ${store}`);
  console.log(`askReceipts: ${ledger}`);
  console.log(`operator: ${operatorId}`);
  console.log(
    envTopicId
      ? `HCS topic (HCS_TOPIC_ID): ${envTopicId}`
      : "HCS topic: none set -- the first anchor call below will create one and reuse it for the rest of this run.",
  );

  const menu = await fetchMenu(store);
  const describePurchase = buildDescribePurchase(menu);
  const checkBudget = createLiveCheckBudget({ url: ledger, agentKey }, describePurchase);

  // --- Steps 1-2: check_budget + buy, for a cheap item expected to approve ---
  section("Step 1: check_budget");
  const approvalResource = `${store}/buy/${APPROVAL_SLUG}`;
  let approvalResult: DecideAndBuyResult;
  try {
    approvalResult = await decideAndBuy(
      { agent: AGENT_ID, resource: approvalResource, operatorId, operatorKey, topicId: envTopicId },
      checkBudget,
    );
  } catch (error) {
    console.error(`check_budget/buy failed outright for ${APPROVAL_SLUG}: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`agent: ${AGENT_ID}`);
  console.log(`resource: ${approvalResource}`);
  console.log(`verdict: ${approvalResult.decision.verdict}`);
  if (approvalResult.decision.budgetRuleId) {
    console.log(`budget rule: ${approvalResult.decision.budgetRuleId}`);
  }
  if (approvalResult.decision.reason) {
    console.log(`reason: ${approvalResult.decision.reason}`);
  }
  console.log(`decision nonce: ${approvalResult.decision.nonce}`);
  console.log(
    `decision anchored pre-payment (E1): ok=${approvalResult.anchor.ok} ` +
      `hash=${approvalResult.anchor.hash} topic=${approvalResult.anchor.topicId ?? "n/a"}`,
  );
  if (approvalResult.anchor.error) {
    console.log(`decision anchor error: ${approvalResult.anchor.error}`);
  }

  const topicId = envTopicId ?? approvalResult.anchor.topicId;
  if (!topicId) {
    console.error(
      "No HCS topic id is available (HCS_TOPIC_ID unset and the decision anchor did not return one) -- cannot anchor or verify a receipt.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`HCS topic in use for this run: ${topicId}`);

  if (approvalResult.outcome !== "purchased") {
    console.error("");
    console.error(
      `UNEXPECTED: expected outcome "purchased" for ${APPROVAL_SLUG}, got "${approvalResult.outcome}".`,
    );
    console.error(
      approvalResult.outcome === "declined"
        ? "The pre-provisioned budget rule appears to be refusing even the cheap item -- " +
            "check its threshold. It must sit strictly between $0.25 and $0.35 (see this " +
            "plan's Prerequisite section for the exact proposed wording)."
        : "The decision could not be anchored to HCS, so nothing was bought -- see the anchor error above.",
    );
    console.error("Steps 3-6 need a genuinely purchased item and cannot run. Stopping here.");
    process.exitCode = 1;
    return;
  }

  section("Step 2: buy (402 -> pay in HBAR)");
  const purchase = approvalResult.purchase;
  console.log(`paid: ${formatHbar(purchase.amountTinybar)} HBAR (${purchase.amountTinybar} tinybar)`);
  console.log(`settlement transaction: ${purchase.settlement.transactionId}`);
  console.log(`hashscan (settlement tx): ${hashscanUrl(purchase.settlement)}`);

  // --- Decline demonstration (E3): the priciest item against the same rule ---
  section("Decline demonstration (E3): cold-brew against the pre-provisioned budget rule");
  const declineResource = `${store}/buy/${DECLINE_SLUG}`;
  let declineResult: DecideAndBuyResult | undefined;
  try {
    declineResult = await decideAndBuy(
      { agent: AGENT_ID, resource: declineResource, operatorId, operatorKey, topicId },
      checkBudget,
    );
  } catch (error) {
    console.error(`ANOMALY: the decline-path call threw instead of returning a decision: ${describeError(error)}`);
    console.error("Continuing with the rest of the walkthrough using the espresso purchase already made above.");
  }

  if (declineResult) {
    console.log(`resource: ${declineResource}`);
    console.log(`verdict: ${declineResult.decision.verdict}`);
    if (declineResult.decision.budgetRuleId) {
      console.log(`budget rule: ${declineResult.decision.budgetRuleId}`);
    }
    if (declineResult.decision.reason) {
      console.log(`reason: ${declineResult.decision.reason}`);
    }
    console.log(
      `decision anchored: ok=${declineResult.anchor.ok} hash=${declineResult.anchor.hash} ` +
        `topic=${declineResult.anchor.topicId ?? topicId}`,
    );

    if (declineResult.outcome === "declined") {
      console.log("Decline demonstration succeeded: the pre-provisioned rule refused this purchase, live.");
    } else {
      console.error("");
      console.error(`ANOMALY: expected outcome "declined" for ${DECLINE_SLUG}, got "${declineResult.outcome}".`);
      console.error(
        declineResult.outcome === "purchased"
          ? "The pre-provisioned budget rule did not trigger -- has it been created yet? " +
              'See this plan\'s Prerequisite section for the exact wording expected ' +
              '("Refuse any agent purchase on the hedera-proof-of-spend store over $0.30.", enforcement "refuse").'
          : "The decision could not be anchored to HCS -- see the anchor error above.",
      );
      console.error("This does not fail the run: continuing with the rest of the walkthrough using the espresso purchase already made above.");
    }
  }

  // --- Step 3: file the receipt ---
  section('Step 3: file the settled purchase as a receipt on rail "hedera"');
  const receipt = buildReceipt(APPROVAL_SLUG, purchase);
  console.log(JSON.stringify(receipt, null, 2));

  // --- Step 4: anchor the receipt hash to HCS ---
  section("Step 4: hash the receipt and submit the hash to the HCS topic");
  const receiptAnchor = await anchorReceipt(receipt, { operatorId, operatorKey, topicId });
  console.log(`hash: ${receiptAnchor.hash}`);
  console.log(`topic: ${receiptAnchor.topicId ?? topicId}`);
  console.log(`anchored: ${receiptAnchor.ok}`);
  if (receiptAnchor.error) {
    console.log(`anchor error: ${receiptAnchor.error}`);
  }

  // --- Step 5: verify independently ---
  section("Step 5: the verifier re-hashes the receipt independently and checks the topic");
  const verifyResult = await verify(receipt, { topicId });
  console.log(`outcome: ${verifyResult.outcome}`);
  console.log(`computed hash: ${verifyResult.computedHash}`);
  if (verifyResult.consensusTimestamp) {
    console.log(`consensus timestamp: ${verifyResult.consensusTimestamp}`);
  }

  // --- Step 6: HashScan ---
  section("Step 6: HashScan shows the same message, on a network neither of us controls");
  if (verifyResult.hashscanUrl) {
    console.log(`hashscan (topic messages): ${verifyResult.hashscanUrl}`);
  } else {
    console.log(`No HashScan topic link available -- outcome was "${verifyResult.outcome}", not "match".`);
  }
  console.log(`(step 2's settlement transaction is also on HashScan: ${hashscanUrl(purchase.settlement)})`);

  // --- Step 7: intentionally cut ---
  section("Step 7: cross-rail total");
  console.log(
    "Intentionally not attempted. No seeding infrastructure exists to put real x402/MPP " +
      'receipts on the shared demo account -- see the README\'s "Verify it yourself" step 7 ' +
      "and docs/design.md's Open Items. Printing a one-rail total and calling it \"cross-rail\" " +
      "would misrepresent what was actually checked, so this step is cut rather than faked.",
  );

  const coreSuccess = verifyResult.outcome === "match";
  console.log("");
  console.log(
    coreSuccess
      ? "RESULT: core proof (purchase, anchor, independent verification) succeeded."
      : `RESULT: core proof did NOT fully succeed (verifier outcome: "${verifyResult.outcome}").`,
  );
  if (!coreSuccess) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
