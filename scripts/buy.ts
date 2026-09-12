/**
 * The one authorised way to buy something from this store: `npm run buy --
 * <slug> --agent <name> [--verdict approved|declined --rule <ruleId>
 * [--reason <text>]]`.
 *
 * Unlike `npm run buy:raw` (packages/buyer/src/cli.ts, a rail-debugging
 * tool with no budget check and no anchor), this command always goes
 * through decide-and-buy.ts's decideAndBuy() -- there is no code path here
 * that reaches a payment without a decision already confirmed at HCS
 * consensus. See .claude/skills/anchor-before-pay/SKILL.md for the
 * full rationale and worked examples.
 *
 * Two callers, one command:
 *
 *   - HEADLESS (ASKRECEIPTS_AGENT_KEY set): this script calls askReceipts'
 *     real check_budget itself, then files the settled purchase's receipt
 *     back to askReceipts afterwards. No agent needs to be in the loop --
 *     this is the path a CI run or a judge with no MCP client uses.
 *   - CALLER-SUPPLIED (ASKRECEIPTS_AGENT_KEY unset): an agent that already
 *     called check_budget itself, over its own MCP session, passes the
 *     verdict it got via --verdict/--rule[/--reason]. No ledger credential
 *     ever touches this process in this mode, and the receipt this command
 *     prints is the caller's own responsibility to file.
 *
 * Refuses to run when NEITHER is available: no ASKRECEIPTS_AGENT_KEY and no
 * --verdict means nobody has actually checked a budget, and this command
 * will not invent a verdict on its own -- an agent that decides for itself
 * whether it may spend is exactly what this project exists to prevent.
 *
 * Exit codes: 0 -- fully complete (a correctly-anchored decline, or a
 * purchase whose receipt has been filed). 1 -- something actually failed
 * (the decision could not be anchored, or argument/environment validation
 * failed). 2 -- a purchase happened but its receipt is not yet filed
 * (caller-supplied mode always lands here, by design; headless mode lands
 * here only if the filing attempt itself failed) -- incomplete, not
 * failed: the purchase and its anchor are both already real.
 */
import type { AnchorResult } from "@proof-of-spend/anchor";
import { assertTestnet, hashscanUrl } from "@proof-of-spend/buyer";
import { createLiveCheckBudget } from "./check-budget-live.ts";
import { decideAndBuy } from "./decide-and-buy.ts";
import type { CheckBudget, DecideAndBuyResult, Decision } from "./decide-and-buy.ts";
import {
  bindReceiptToDecision,
  buildDescribePurchase,
  buildReceipt,
  fetchMenu,
} from "./e2e.ts";
import type { DescribePurchase } from "./check-budget-live.ts";
import { saveReceiptLive } from "./save-receipt-live.ts";

const DEFAULT_STORE_URL = "https://hedera-proof-of-spend-store.vercel.app";
const DEFAULT_ASKRECEIPTS_URL = "https://www.askreceipts.com/api/mcp";
const FALLBACK_MERCHANT = "hedera-proof-of-spend store";
const TINYBAR_PER_HBAR = 100_000_000n;

export interface Args {
  readonly slug: string;
  readonly agent: string;
  /** Present only when --verdict was given (caller-supplied mode). */
  readonly verdict?: "approved" | "declined";
  readonly ruleId?: string;
  readonly reason?: string;
  readonly topicId?: string;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  let slug: string | undefined;
  let agent: string | undefined;
  let verdict: string | undefined;
  let ruleId: string | undefined;
  let reason: string | undefined;
  let topicId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--agent") agent = argv[(i += 1)];
    else if (flag === "--verdict") verdict = argv[(i += 1)];
    else if (flag === "--rule") ruleId = argv[(i += 1)];
    else if (flag === "--reason") reason = argv[(i += 1)];
    else if (flag === "--topic") topicId = argv[(i += 1)];
    else if (!flag.startsWith("--") && slug === undefined) slug = flag;
  }

  if (!slug) {
    throw new Error(
      "Missing the menu slug to buy. Usage: npm run buy -- <slug> --agent <name> " +
        "[--verdict approved|declined --rule <ruleId>]",
    );
  }
  if (!agent) {
    throw new Error("Missing --agent <name> -- the agent identity this purchase is anchored under.");
  }

  let resolvedVerdict: "approved" | "declined" | undefined;
  if (verdict !== undefined) {
    if (verdict !== "approved" && verdict !== "declined") {
      throw new Error(`--verdict must be "approved" or "declined" (got "${verdict}").`);
    }
    resolvedVerdict = verdict;
    // budgetRuleId is a required, non-optional field on Decision (see
    // decide-and-buy.ts: "none" is a real sentinel, not an omission) -- a
    // caller-supplied verdict must say where it came from, even if that's
    // "none", so this is never silently dropped from what gets anchored.
    if (!ruleId) {
      throw new Error(
        "--verdict was given but --rule was not -- name the budget rule this verdict came " +
          'from (or pass --rule none if the checker reported no rule id).',
      );
    }
  }

  return {
    slug,
    agent,
    verdict: resolvedVerdict,
    ruleId,
    reason,
    topicId: topicId || env.HCS_TOPIC_ID?.trim() || undefined,
  };
}

/** A CheckBudget that never actually checks anything -- it returns exactly
 *  the verdict a caller already obtained over its own MCP session, ignoring
 *  its own request argument. Used only in caller-supplied mode, where no
 *  askReceipts credential is available to this process at all. */
export function callerSuppliedCheckBudget(
  verdict: "approved" | "declined",
  ruleId: string,
  reason: string | undefined,
): CheckBudget {
  return async () => ({ verdict, budgetRuleId: ruleId, reason });
}

/**
 * Decides which of the two callers this run is, and REFUSES (throws)
 * outright when neither is available -- no ASKRECEIPTS_AGENT_KEY and no
 * caller-supplied verdict means nobody has actually checked a budget, and
 * this command will not invent a verdict of its own. Pulled out as a pure
 * function so this refusal -- the single most important behaviour in this
 * file -- is directly testable without touching the environment or the
 * network, the same way exitCodeFor() below makes the exit-code contract
 * testable.
 */
export function resolveMode(
  agentKey: string | undefined,
  verdict: "approved" | "declined" | undefined,
): "headless" | "caller-supplied" {
  if (!agentKey && verdict === undefined) {
    throw new Error(
      "Refusing to buy: neither ASKRECEIPTS_AGENT_KEY nor --verdict is set. An agent that " +
        "decides for itself whether it may spend is exactly what this project exists to " +
        "prevent. Either set ASKRECEIPTS_AGENT_KEY so this command checks the budget itself, " +
        "or pass --verdict approved|declined --rule <ruleId>, from a caller that already " +
        "checked over MCP.",
    );
  }
  return agentKey ? "headless" : "caller-supplied";
}

/**
 * The exit-code contract this command promises, pulled out as a pure
 * function so it is directly testable without decideAndBuy()'s own network
 * calls. See this file's top doc comment for what each code means.
 */
export function exitCodeFor(outcome: Decision["verdict"] | "anchor_failed", filed: boolean): number {
  if (outcome === "anchor_failed") return 1;
  if (outcome === "declined") return 0;
  // outcome === "approved" (a completed purchase)
  return filed ? 0 : 2;
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

function askReceiptsUrl(): string {
  const configured = process.env.ASKRECEIPTS_URL?.trim();
  return (configured || DEFAULT_ASKRECEIPTS_URL).replace(/\/$/, "");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `anchor` field exactly as SKILL.md fixes it: `topic <id> seq #<n> ·
 * hash <first 16 chars>…`. Shared by the decline and purchase paths so the
 * two cannot drift apart, and so the hash is truncated identically in both
 * -- the skill asks for a 16-character prefix, which is what an operator
 * compares against the mirror node by eye.
 */
export function anchorField(anchor: AnchorResult): string {
  const topic = anchor.topicId ?? "unknown";
  const seq = anchor.sequenceNumber === undefined ? "?" : `#${anchor.sequenceNumber}`;
  return `topic ${topic} seq ${seq} · hash ${anchor.hash.slice(0, 16)}…`;
}

/**
 * Everything in the report EXCEPT its last field: the headline, a blank
 * line, then `budget`, `anchor` and `payment`. The `receipt` field is
 * deliberately not here -- on a purchase it is not known until the filing
 * attempt has finished, and these lines must be printable BEFORE that
 * attempt so a filing that hangs or throws can never cost the operator
 * sight of a transaction id for a payment that has already settled. See
 * receiptField() for the last line, and main() for how the two are joined.
 *
 * Pure, and exported, so the format SKILL.md fixes ("one headline and all
 * four fields ... Nothing may be left out") is enforced by buy.test.ts
 * rather than merely written down in the doc.
 */
export function reportHead(slug: string, result: DecideAndBuyResult): readonly string[] {
  if (result.outcome === "anchor_failed") {
    return [
      `${slug} not bought — the decision could not be confirmed at consensus`,
      "",
      `budget      ${result.decision.verdict} · rule ${result.decision.budgetRuleId}`,
      `anchor      failed — ${result.message}`,
      `payment     none — nothing moved`,
    ];
  }

  if (result.outcome === "declined") {
    return [
      `${slug} refused — ${result.decision.reason ?? "the budget declined it"}`,
      "",
      `budget      declined · rule ${result.decision.budgetRuleId}`,
      `anchor      ${anchorField(result.anchor)}`,
      `payment     none — nothing moved`,
    ];
  }

  return [
    `${slug} bought — ${formatHbar(result.purchase.amountTinybar)} HBAR, within budget`,
    "",
    `budget      approved · rule ${result.decision.budgetRuleId}`,
    `anchor      ${anchorField(result.anchor)}`,
    `payment     ${result.purchase.settlement.transactionId} · ${hashscanUrl(result.purchase.settlement)}`,
  ];
}

/**
 * The report's last field. Never returns an empty or absent value: an
 * unfiled receipt is the one outcome that must be loud rather than silent,
 * because a spend the ledger cannot see is a spend the next budget check
 * cannot subtract -- which is exactly when a cap stops binding.
 */
export function receiptField(
  outcome: DecideAndBuyResult["outcome"],
  mode: "headless" | "caller-supplied",
  filed: boolean,
): string {
  if (outcome === "anchor_failed") return "receipt     none — nothing to file";
  // A decline anchored correctly is a complete, successful outcome on its
  // own -- nothing settled, so there is no receipt to file. This is what
  // anchoring a refusal is for: the anchor is already the durable evidence,
  // whether or not anyone ever files anything about it.
  if (outcome === "declined") {
    return "receipt     none — a refusal files nothing; the anchor is the record";
  }
  if (filed) return "receipt     filed";
  return mode === "headless"
    ? "receipt     NOT FILED — filing failed; file the receipt below before the next purchase"
    : "receipt     NOT FILED — file this to askReceipts yourself (save_receipt) before the next purchase";
}

function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = tinybar % TINYBAR_PER_HBAR;
  const fractionDigits = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  return fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : `${whole}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const agentKey = process.env.ASKRECEIPTS_AGENT_KEY?.trim() || undefined;

  // Resolved -- and refused, if neither an agent key nor a caller-supplied
  // verdict is available -- BEFORE requireEnv() below even asks for
  // operator credentials, so the refusal is what a misconfigured caller
  // actually sees first, not a confusing "HEDERA_OPERATOR_ID is not set"
  // that has nothing to do with what they actually got wrong.
  const mode = resolveMode(agentKey, args.verdict);
  if (mode === "headless" && args.verdict !== undefined) {
    console.log(
      "note: ASKRECEIPTS_AGENT_KEY is set, so this command checks the budget itself -- " +
        "the --verdict/--rule/--reason you passed are ignored.",
    );
  }

  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorKey = requireEnv("HEDERA_OPERATOR_KEY");
  assertTestnet(process.env.HEDERA_NETWORK);

  const store = storeUrl();
  const resource = `${store}/buy/${args.slug}`;

  console.log(`mode: ${mode}`);
  console.log(`agent: ${args.agent}`);
  console.log(`resource: ${resource}`);

  let checkBudget: CheckBudget;
  let describePurchase: DescribePurchase | undefined;
  if (mode === "headless") {
    const menu = await fetchMenu(store);
    describePurchase = buildDescribePurchase(menu);
    checkBudget = createLiveCheckBudget({ url: askReceiptsUrl(), agentKey: agentKey! }, describePurchase);
  } else {
    checkBudget = callerSuppliedCheckBudget(args.verdict!, args.ruleId!, args.reason);
  }

  const result = await decideAndBuy(
    { agent: args.agent, resource, operatorId, operatorKey, topicId: args.topicId },
    checkBudget,
  );

  // Neither outcome below settles anything, so the whole report -- last
  // field included -- is known up front and prints in one go.
  if (result.outcome === "anchor_failed" || result.outcome === "declined") {
    for (const line of reportHead(args.slug, result)) console.log(line);
    console.log(receiptField(result.outcome, mode, false));
    process.exitCode = exitCodeFor(
      result.outcome === "anchor_failed" ? "anchor_failed" : "declined",
      false,
    );
    return;
  }

  // result.outcome === "purchased"
  const baseReceipt = buildReceipt(args.slug, result.purchase);
  // Guarded: a real payment has already settled by this point (result.purchase
  // is real), so a bindReceiptToDecision() failure (missing topicId/
  // sequenceNumber -- see its own doc comment) must never cost the operator
  // their receipt, transaction id, and HashScan link. Same reasoning and the
  // same fallback-to-baseReceipt shape as scripts/e2e.ts's own Step 3.
  let receipt: Record<string, unknown> = baseReceipt;
  try {
    receipt = bindReceiptToDecision(baseReceipt, result.decision, {
      topicId: result.anchor.topicId,
      sequenceNumber: result.anchor.sequenceNumber,
    });
  } catch (error) {
    console.error(`Could not bind the receipt to its authorizing decision: ${describeError(error)}`);
    console.error(
      "Continuing with an unbound receipt -- the purchase and its anchor are still real.",
    );
  }

  // Printed BEFORE the filing attempt below, so a filing that hangs or throws
  // can never cost the operator sight of the transaction id and HashScan link
  // for a payment that has already settled. The `receipt` field is the only
  // one that has to wait for filing, and it is the last field anyway; filing
  // failures go to stderr, so stdout still reads as one contiguous report.
  for (const line of reportHead(args.slug, result)) console.log(line);

  let filed = false;
  if (mode === "headless") {
    try {
      const purchaseDescription = describePurchase!({ agent: args.agent, resource });
      const saveReceipt = saveReceiptLive({ url: askReceiptsUrl(), agentKey: agentKey! });
      await saveReceipt(
        {
          merchant: purchaseDescription.merchant ?? FALLBACK_MERCHANT,
          amount: purchaseDescription.amount,
          currency: purchaseDescription.currency,
          timestamp: new Date().toISOString(),
          paymentIntentId: result.purchase.settlement.transactionId,
          lineItems: [
            { description: purchaseDescription.description ?? args.slug, amount: purchaseDescription.amount },
          ],
        },
        args.agent,
      );
      filed = true;
    } catch (error) {
      console.error(`Could not file receipt to askReceipts: ${describeError(error)}`);
      console.error("The purchase and its anchor are still real -- only the filing failed.");
    }
  }

  console.log(receiptField("purchased", mode, filed));

  console.log(JSON.stringify(receipt, null, 2));

  process.exitCode = exitCodeFor("approved", filed);
}

// Only run when this file is executed directly (`npm run buy`, or
// `node scripts/buy.ts`) -- not when imported, e.g. by its own test suite.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
