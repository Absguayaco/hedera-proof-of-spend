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
 * HashScan links.
 *
 * The receipt filed in step 3 also carries the full Decision object that
 * authorized the purchase (not just a hash reference to it), plus a
 * structured {nonce, topicId, sequenceNumber} pointer back to that
 * decision's own HCS anchor (Build Kit B2/B3). Between steps 5 and 6, this
 * script independently re-verifies that decision's anchor and then checks
 * that it reached HCS consensus strictly before the payment settled (Build
 * Kit A2/A3/A6/A7) -- the same two checks a third party holding only the
 * filed receipt and public mirror-node access could run themselves.
 *
 * Steps 1-2 are one decideAndBuy() call under the hood (see
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
// module scope — belt-and-braces: the file's several `export` declarations
// below already make this unambiguously a module, but the plan mandates
// keeping this statement, so it stays even though it's now redundant.
export {};

import { anchorReceipt } from "@proof-of-spend/anchor";
import { assertTestnet, hashscanUrl } from "@proof-of-spend/buyer";
import type { BuyResult } from "@proof-of-spend/buyer";
import { verify, verifyAtSequence, verifyDecisionPrecedesSettlement } from "@proof-of-spend/verifier";
import type { OrderingProofResult, VerifyResult } from "@proof-of-spend/verifier";
import { createLiveCheckBudget } from "./check-budget-live.ts";
import type { CheckBudgetPurchase, DescribePurchase } from "./check-budget-live.ts";
import { decideAndBuy, linkReceiptToDecision } from "./decide-and-buy.ts";
import type { BudgetCheckRequest, Decision, DecideAndBuyResult } from "./decide-and-buy.ts";

const TINYBAR_PER_HBAR = 100_000_000n;
const MERCHANT = "hedera-proof-of-spend store";
const DEFAULT_STORE_URL = "https://hedera-proof-of-spend-store.vercel.app";
const DEFAULT_ASKRECEIPTS_URL = "https://www.askreceipts.com/api/mcp";
const AGENT_ID = "hedera-proof-of-spend-e2e-agent";
const APPROVAL_SLUG = "espresso";
const DECLINE_SLUG = "cold-brew";

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

/**
 * Composes this script's own buildReceipt() with decide-and-buy's
 * linkReceiptToDecision() (B2/B3: a structured {nonce, topicId,
 * sequenceNumber} pointer from receipt back to the decision that authorized
 * it), and additionally embeds the FULL authorizing Decision object under
 * `authorizingDecision` — not just that structural pointer.
 *
 * The pointer alone is not enough for a third party to independently verify
 * the decision: it identifies a specific anchored HCS message, but a hash
 * proves nothing without its preimage, and the topic itself carries only
 * {v, h} by design (see packages/anchor/src/topic.ts's AnchorMessage doc
 * comment: "only the hash leaves the system"). The receipt, unlike the
 * topic, was always meant to be disclosed — so this is where that preimage
 * is handed over: a third party holding only this receipt can hash
 * `authorizingDecision`, confirm it via verify(authorizingDecision,
 * {topicId}), and then run verifyDecisionPrecedesSettlement() themselves,
 * without ever needing to ask this script's operator for anything.
 *
 * `anchor` takes only the two optional fields it needs (not a whole
 * AnchorResult) so this function stays trivially testable. topicId and
 * sequenceNumber are required by DecisionReceiptRef but optional on
 * AnchorResult itself (see linkReceiptToDecision()'s own doc comment on why
 * TypeScript can't narrow that from a sibling `outcome` discriminant) — so
 * this throws, naming the decision's nonce, rather than silently binding to
 * a fabricated topic id or sequence number.
 */
export function bindReceiptToDecision(
  receipt: Record<string, unknown>,
  decision: Decision,
  anchor: { topicId?: string; sequenceNumber?: string },
): Record<string, unknown> {
  if (!anchor.topicId || !anchor.sequenceNumber) {
    throw new Error(
      `Cannot bind receipt to decision ${decision.nonce}: its anchor is missing topicId or ` +
        `sequenceNumber (topicId=${anchor.topicId ?? "unset"}, ` +
        `sequenceNumber=${anchor.sequenceNumber ?? "unset"}).`,
    );
  }
  const linked = linkReceiptToDecision(receipt, {
    nonce: decision.nonce,
    topicId: anchor.topicId,
    sequenceNumber: anchor.sequenceNumber,
  });
  return { ...linked, authorizingDecision: decision };
}

const MIRROR_NODE_MAX_ATTEMPTS = 6;
const MIRROR_NODE_RETRY_DELAY_MS = 5_000;

/**
 * Wraps verify() with this script's bounded-retry pattern for mirror-node
 * ingestion lag (HCS consensus and the mirror node's REST API are separate
 * systems; this repo's own prior work measured a real ~8.68s gap between
 * them). Shared by the receipt verify (step 5) and the decision verify (the
 * ordering-proof section) so the retry shape lives in exactly one place
 * instead of being duplicated per call site. `label` distinguishes the two
 * in the retry log line only ("receipt" / "decision").
 */
export async function verifyWithRetry(
  target: unknown,
  opts: { topicId: string },
  label: string,
  verifyImpl: typeof verify = verify,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<VerifyResult> {
  let result = await verifyImpl(target, opts);
  let attempt = 1;
  while (result.outcome === "missing" && attempt < MIRROR_NODE_MAX_ATTEMPTS) {
    attempt += 1;
    console.log(
      `${label}: not yet visible on the mirror node, retrying (${attempt}/${MIRROR_NODE_MAX_ATTEMPTS})...`,
    );
    await sleepImpl(MIRROR_NODE_RETRY_DELAY_MS);
    result = await verifyImpl(target, opts);
  }
  return result;
}

function requireEnv(name: string, message?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(message ?? `${name} is not set. See .env.example.`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorKey = requireEnv("HEDERA_OPERATOR_KEY");
  const agentKey = requireEnv(
    "ASKRECEIPTS_AGENT_KEY",
    "ASKRECEIPTS_AGENT_KEY is not set. The public demo token is not yet published; supply an " +
      "askReceipts agent key (ar_agent_live_... or ar_agent_demo_...) until it is.",
  );
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
  if (topicId) {
    console.log(`HCS topic in use for this run: ${topicId}`);
  }

  // Checked before the generic topic-availability guard below: when the
  // outcome is "anchor_failed" specifically because topic creation itself
  // failed, this branch's message explains why, which is more useful than
  // the generic "no topic id" message that guard would otherwise show first.
  if (approvalResult.outcome !== "purchased") {
    console.error("");
    console.error(
      `UNEXPECTED: expected outcome "purchased" for ${APPROVAL_SLUG}, got "${approvalResult.outcome}".`,
    );
    console.error(
      approvalResult.outcome === "declined"
        ? "The pre-provisioned budget rule appears to be refusing even the cheap item -- " +
            "either the rule's threshold is wrong (it must sit strictly between $0.25 and " +
            "$0.35) or askReceipts could not evaluate it -- see the `reason:` line above. See " +
            "docs/superpowers/plans/2026-09-09-e2e-walkthrough.md's Prerequisite section for " +
            "the exact proposed wording."
        : "The decision could not be anchored to HCS, so nothing was bought -- see the anchor error above.",
    );
    console.error("Steps 3-6 need a genuinely purchased item and cannot run. Stopping here.");
    process.exitCode = 1;
    return;
  }

  if (!topicId) {
    console.error(
      "No HCS topic id is available (HCS_TOPIC_ID unset and the decision anchor did not return one) -- cannot anchor or verify a receipt.",
    );
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
              "See docs/superpowers/plans/2026-09-09-e2e-walkthrough.md's Prerequisite " +
              'section for the exact wording expected ("Refuse any agent purchase on the ' +
              'hedera-proof-of-spend store over $0.30.", enforcement "refuse").'
          : "The decision could not be anchored to HCS -- see the anchor error above.",
      );
      console.error("This does not fail the run: continuing with the rest of the walkthrough using the espresso purchase already made above.");
    }
  }

  // --- Step 3: file the receipt, bound to the decision that authorized it ---
  section('Step 3: file the settled purchase as a receipt on rail "hedera"');
  const baseReceipt = buildReceipt(APPROVAL_SLUG, purchase);
  let receipt: Record<string, unknown> = baseReceipt;
  let bindError: unknown;
  try {
    receipt = bindReceiptToDecision(baseReceipt, approvalResult.decision, {
      topicId: approvalResult.anchor.topicId,
      sequenceNumber: approvalResult.anchor.sequenceNumber,
    });
  } catch (error) {
    bindError = error;
    console.error(`Could not bind the receipt to its authorizing decision: ${describeError(error)}`);
    console.error(
      "Continuing with an unbound receipt -- the ordering proof (A2/A3/A6/A7) below will be skipped.",
    );
  }
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
  // HCS consensus (step 4) and the public mirror node's REST API are
  // separate systems: the mirror node ingests messages *after* consensus,
  // with real-world lag (this repo's own prior work measured an ~8.68s gap
  // on a real transaction). verifyWithRetry() polls for up to ~30s before
  // treating "missing" as genuine.
  section("Step 5: the verifier re-hashes the receipt independently and checks the topic");
  let verifyResult: VerifyResult | undefined;
  let verifyCheckError: unknown;
  try {
    verifyResult = await verifyWithRetry(receipt, { topicId }, "receipt");
    console.log(`outcome: ${verifyResult.outcome}`);
    console.log(`computed hash: ${verifyResult.computedHash}`);
    if (verifyResult.consensusTimestamp) {
      console.log(`consensus timestamp: ${verifyResult.consensusTimestamp}`);
    }
  } catch (error) {
    // The purchase (step 2) and HCS anchor (step 4) already genuinely
    // succeeded by this point -- a mirror-node failure here is "could not
    // check", not "checked and did not match", and must not read as either
    // a verification mismatch or take down the rest of the walkthrough.
    verifyResult = undefined;
    verifyCheckError = error;
    console.error(`Could not verify against the mirror node: ${describeError(error)}`);
    console.error(
      'This is "could not check" -- not "checked and did not match". The purchase and HCS ' +
        "anchor above already succeeded independently of this step.",
    );
  }

  // --- Ordering proof (A2/A3/A6/A7): independently confirm the decision's
  // own HCS anchor, then confirm it reached consensus strictly before the
  // payment settled -- checkable by a third party from the receipt (which
  // now carries the full authorizingDecision) and public mirror-node data
  // alone, with no trust in this script's own code sequencing required. ---
  section("Ordering proof (A2/A3/A6/A7): decision anchored strictly before settlement");
  let decisionVerifyResult: VerifyResult | undefined;
  let orderingResult: OrderingProofResult | undefined;
  let orderingCheckError: unknown;
  let sequenceMatch: boolean | undefined;
  if (bindError) {
    console.log("Skipped: the receipt could not be bound to its decision (see Step 3 above).");
  } else {
    try {
      // Position-based, not a scan: this looks up the exact message
      // approvalResult.anchor.sequenceNumber claims, so a mismatch here is
      // "altered" (something tampered with the decision or its reference),
      // not merely "missing" -- see packages/verifier's verifyAtSequence()
      // doc comment. This also makes the old separate sequence-number
      // cross-check redundant: this call already fetches by that exact
      // position, so the mirror node reporting it back proves nothing new.
      if (!approvalResult.anchor.sequenceNumber) {
        throw new Error(
          "Decision anchor has no sequenceNumber -- cannot look up its exact position.",
        );
      }
      decisionVerifyResult = await verifyAtSequence(approvalResult.decision, {
        topicId,
        sequenceNumber: approvalResult.anchor.sequenceNumber,
      });
      console.log(`decision anchor outcome: ${decisionVerifyResult.outcome}`);
      if (decisionVerifyResult.consensusTimestamp) {
        console.log(`decision consensus timestamp: ${decisionVerifyResult.consensusTimestamp}`);
      }
      sequenceMatch = decisionVerifyResult.outcome === "match";

      orderingResult = await verifyDecisionPrecedesSettlement(
        decisionVerifyResult,
        purchase.settlement.transactionId,
      );
      console.log(`ordering outcome: ${orderingResult.outcome}`);
      if (orderingResult.decisionConsensusTimestamp) {
        console.log(
          `ordering proof's decision consensus timestamp: ${orderingResult.decisionConsensusTimestamp}`,
        );
      }
      if (orderingResult.settlementConsensusTimestamp) {
        console.log(`settlement consensus timestamp: ${orderingResult.settlementConsensusTimestamp}`);
      }
    } catch (error) {
      orderingCheckError = error;
      console.error(`Could not complete the ordering proof: ${describeError(error)}`);
      console.error('This is "could not check" -- not "checked and did not match".');
    }
  }

  // --- Step 6: HashScan ---
  section("Step 6: HashScan shows the same message, on a network neither of us controls");
  if (verifyResult?.hashscanUrl) {
    console.log(`hashscan (topic messages): ${verifyResult.hashscanUrl}`);
  } else if (verifyCheckError) {
    console.log(
      "hashscan (topic messages, not confirmed by this script -- see the mirror-node error " +
        `above): https://hashscan.io/testnet/topic/${topicId}/messages`,
    );
  } else {
    console.log(`No HashScan topic link available -- outcome was "${verifyResult?.outcome}", not "match".`);
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

  // Three independent checks now feed this summary (receipt verify, decision
  // verify, ordering proof). Each can land in one of three buckets: it
  // genuinely CONFIRMED the claim, it genuinely CONTRADICTED the claim (a
  // negative that matters and must never be hidden behind an unrelated
  // "could not check" elsewhere), or it could not be completed at all
  // (mirror-node error, or -- for the ordering proof's settlement lookup
  // specifically -- its own retry budget exhausted without ever finding the
  // settlement transaction, the same "ingestion lag, not evidence" reasoning
  // Step 5 already applies to receipt verification). A completed negative
  // always outranks bindError and "could not check", so a real contradiction
  // can never get reported as a shrug.
  const receiptMatch = verifyResult?.outcome === "match";
  const decisionMatch = decisionVerifyResult?.outcome === "match";
  const orderingBeforeSettlement = orderingResult?.outcome === "decision_before_settlement";
  const orderingInconclusive = orderingResult?.outcome === "settlement_not_found";
  const orderingContradicted =
    orderingResult !== undefined && !orderingBeforeSettlement && !orderingInconclusive;

  const coreSuccess = receiptMatch && decisionMatch && sequenceMatch === true && orderingBeforeSettlement;

  const checkedNegative =
    (verifyResult !== undefined && !receiptMatch) ||
    (decisionVerifyResult !== undefined && !decisionMatch) ||
    sequenceMatch === false ||
    orderingContradicted;

  const couldNotCheck =
    verifyCheckError !== undefined || orderingCheckError !== undefined || orderingInconclusive;

  console.log("");
  if (coreSuccess) {
    console.log(
      "RESULT: core proof (purchase, anchor, independent verification, and the decision-before-" +
        "settlement ordering proof) succeeded.",
    );
  } else if (checkedNegative) {
    console.log(
      'RESULT: core proof did NOT hold -- this is "checked and did not match", not "could not ' +
        `check" (receipt: "${verifyResult?.outcome ?? "not checked"}", decision: ` +
        `"${decisionVerifyResult?.outcome ?? "not checked"}", sequence number cross-check: ` +
        `${sequenceMatch === false ? "no match" : sequenceMatch === true ? "match" : "not checked"}, ` +
        `ordering: "${orderingResult?.outcome ?? "not checked"}"). See the output above for which ` +
        "check failed.",
    );
  } else if (bindError) {
    console.log(
      "RESULT: core proof's purchase and anchor succeeded, but the receipt could not be bound to " +
        "its authorizing decision (see Step 3 above), so the decision verify and ordering proof " +
        `did not run. Receipt verification alone: "${verifyResult?.outcome ?? "not checked"}".`,
    );
  } else if (couldNotCheck) {
    console.log(
      'RESULT: core proof\'s purchase and anchor succeeded, but independent verification or the ' +
        "ordering proof could NOT be fully checked (mirror node error, or the settlement lookup's " +
        'own retry budget was exhausted) -- this is "could not check", not "checked and did not ' +
        'match". See the errors/outcomes above.',
    );
  } else {
    console.log(
      `RESULT: core proof did NOT fully succeed (verifier outcome: "${verifyResult?.outcome}", ` +
        `decision anchor outcome: "${decisionVerifyResult?.outcome ?? "not checked"}", ` +
        `ordering outcome: "${orderingResult?.outcome ?? "not checked"}").`,
    );
  }
  if (!coreSuccess) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
