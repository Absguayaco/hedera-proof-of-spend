/**
 * Anchors a spend DECISION to HCS *before* payment executes, and gates
 * payment on that anchor genuinely reaching consensus — additive to, not a
 * replacement for, the existing post-payment receipt anchoring in
 * packages/anchor. Both anchors use the same anchorReceipt() unmodified;
 * this file only decides WHEN to call it and WHAT to anchor.
 *
 * The real askReceipts check_budget call is out of scope here — CheckBudget
 * is a placeholder contract this module's caller must supply. See the
 * doc comment on CheckBudget below.
 *
 * Build Kit B6 (nonce-replay enforcement) was evaluated here, not merely
 * deferred, and found to be a non-issue BY CONSTRUCTION -- not something
 * left undone. decideAndBuy() decides and buys atomically, inside one
 * function call: a fresh `randomUUID()` nonce is generated fresh on every
 * invocation (see `nonce: randomUUID()` below), the resulting decision is
 * anchored immediately, and the purchase attempt (or refusal) that follows
 * happens inside that same call, before decideAndBuy() ever returns. There
 * is no separate "redeem this decision later" step, no persisted decision
 * record awaiting redemption, and no state shared across calls that a
 * replayed nonce could target -- by the time any caller could observe a
 * decision's nonce, that decision has already been fully consumed (anchored,
 * and either bought or declined). A replay check exists to guard against
 * reusing a credential to trigger a second, unintended effect; here the
 * "credential" and the "effect" are produced and consumed inside the same
 * synchronous call graph, so there is nothing left over for a replay to
 * redeem. See the "B6" describe block in decide-and-buy.test.ts for a
 * construction proof: two concurrent calls for the identical request each
 * get their own nonce, each genuinely anchor, and each genuinely attempt
 * their own purchase, with no shared state between them a replay could
 * exploit.
 *
 * Build Kit B1 (the anchored decision must name the money, not just the
 * URL) is closed here too: `amount`, `currency`, and `payTo` on Decision
 * are populated from the store's own live x402 payment-required challenge
 * at decision time (via @proof-of-spend/buyer's quoteResource()), and the
 * SAME quote is what settleQuote() is later paid against -- never a second,
 * independently-fetched one. See Decision's own field-level doc comments
 * for why.
 */
import { randomUUID } from "node:crypto";
import { anchorReceipt } from "@proof-of-spend/anchor";
import type { AnchorResult } from "@proof-of-spend/anchor";
import { quoteResource, settleQuote } from "@proof-of-spend/buyer";
import type { BuyResult, HederaQuote } from "@proof-of-spend/buyer";

export interface Decision {
  readonly agent: string;
  readonly resource: string;
  readonly verdict: "approved" | "declined";
  /** Tinybar amount the store's own LIVE 402 challenge quoted for this
   *  resource at decision time, as a decimal string — not a cached menu
   *  price. This is what closes Build Kit B1: the anchored authorization
   *  now names an exact amount, not just a URL. Populated for a declined
   *  decision too, with the same rigor as an approval (see this file's E1
   *  note on decideAndBuy() below) -- a decline is anchored against the
   *  same live quote it would have paid, had it been approved. */
  readonly amount: string;
  /** Fixed: packages/buyer settles exactly one asset, native HBAR — this is
   *  a label, not a live-derived value, because there is nothing else it
   *  could be while that remains true. */
  readonly currency: "HBAR";
  /** Hedera account id the payment settles to, per the same live quote. */
  readonly payTo: string;
  /** "none" when no specific budget rule governed this decision (a blanket
   *  allow, or an askReceipts account with enforcing:0) — ALWAYS present,
   *  so the absence of a governing rule is itself part of what's anchored,
   *  rather than silently dropped from the hash. This project's hash-spec
   *  rule 5 (packages/anchor/src/hash.ts) omits any key whose value is
   *  undefined before hashing -- an optional budgetRuleId would let "no
   *  rule governed this" vanish from the preimage without a trace. */
  readonly budgetRuleId: string;
  readonly reason?: string;
  readonly nonce: string;
  readonly decidedAt: string; // ISO 8601
}

export interface BudgetCheckRequest {
  readonly agent: string;
  readonly resource: string;
}

export interface BudgetCheckResponse {
  readonly verdict: "approved" | "declined";
  readonly budgetRuleId?: string;
  readonly reason?: string;
}

/**
 * PLACEHOLDER CONTRACT. This module's own minimal guess at a generic shape,
 * predating live verification of the real tool. The real schema is now known
 * and implemented at scripts/check-budget-live.ts (Bearer-token auth, not
 * OAuth as this comment used to claim) — but nothing in *this* file uses it
 * yet, so this shape stays as-is until a human wires that up. Do not treat
 * this shape as ground truth; check-budget-live.ts is.
 */
export type CheckBudget = (request: BudgetCheckRequest) => Promise<BudgetCheckResponse>;

export interface DecideAndBuyRequest {
  readonly agent: string;
  readonly resource: string; // becomes BuyRequest.url on approval
  readonly operatorId: string;
  readonly operatorKey: string;
  readonly topicId?: string; // omit to create a fresh topic, same as anchorReceipt()
}

interface DecideAndBuyBase {
  readonly decision: Decision;
  readonly anchor: AnchorResult;
}

export type DecideAndBuyResult =
  | (DecideAndBuyBase & { readonly outcome: "anchor_failed"; readonly message: string })
  | (DecideAndBuyBase & { readonly outcome: "declined" })
  | (DecideAndBuyBase & { readonly outcome: "purchased"; readonly purchase: BuyResult });

export async function decideAndBuy(
  request: DecideAndBuyRequest,
  checkBudget: CheckBudget,
  anchorReceiptImpl: typeof anchorReceipt = anchorReceipt,
  quoteResourceImpl: typeof quoteResource = quoteResource,
  settleQuoteImpl: typeof settleQuote = settleQuote,
): Promise<DecideAndBuyResult> {
  let budget: BudgetCheckResponse;
  try {
    budget = await checkBudget({ agent: request.agent, resource: request.resource });
  } catch (error) {
    throw new Error(
      `Refusing to buy: the budget check for ${request.agent} on ${request.resource} failed, ` +
        `so no decision was anchored and nothing was bought: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }

  // B1: the money the decision authorizes comes from the store's own LIVE
  // quote, fetched here -- BEFORE the decision is built or anchored -- not
  // from anything cached or assumed. Fetched for a decline too (E1: same
  // rigor, no special-casing) so every anchored decision, whatever its
  // verdict, names a real amount and payee.
  let quote: HederaQuote;
  try {
    quote = await quoteResourceImpl(request.resource);
  } catch (error) {
    throw new Error(
      `Refusing to buy: could not determine the amount and payee for ${request.resource} ` +
        `from the store's own payment challenge, so no decision was anchored and nothing was ` +
        `bought: ` + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }

  const decision: Decision = {
    agent: request.agent,
    resource: request.resource,
    verdict: budget.verdict,
    amount: quote.amountTinybar,
    currency: "HBAR",
    payTo: quote.payTo,
    // See this file's top doc comment ("Build Kit B6") for why a fresh
    // nonce on every call is enough to close the nonce-replay concern
    // without a separate replay-check.
    budgetRuleId: budget.budgetRuleId ?? "none",
    reason: budget.reason,
    nonce: randomUUID(),
    decidedAt: new Date().toISOString(),
  };

  const anchor = await anchorReceiptImpl(decision, {
    operatorId: request.operatorId,
    operatorKey: request.operatorKey,
    topicId: request.topicId,
  });

  if (!anchor.ok) {
    return {
      outcome: "anchor_failed",
      decision,
      anchor,
      message:
        `Refusing to buy: decision ${decision.nonce} could not be confirmed at HCS ` +
        `consensus, so there is no proof it happened at all.` +
        (anchor.error ? ` ${anchor.error}` : ""),
    };
  }

  if (decision.verdict !== "approved") {
    return { outcome: "declined", decision, anchor };
  }

  try {
    // Settled against the SAME quote that was just anchored -- never a
    // second, independently-fetched one -- so the anchored amount/payTo and
    // the amount/payee actually paid can never disagree.
    const purchase = await settleQuoteImpl(
      request.resource,
      quote,
      request.operatorId,
      request.operatorKey,
    );
    return { outcome: "purchased", decision, anchor, purchase };
  } catch (error) {
    throw new Error(
      `Decision ${decision.nonce} was anchored at consensus (hash ${anchor.hash}, ` +
        `topic ${anchor.topicId ?? "unknown"}) but the purchase failed: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

/** The structured reference linkReceiptToDecision() attaches to a filed
 *  receipt. Every value here is a decimal STRING, per this project's
 *  hash-spec rule that rejects raw JS numbers (packages/anchor/src/hash.ts's
 *  canonicalize(), rule 2) -- nonce is already a string (randomUUID()),
 *  topicId is already a string, and sequenceNumber is the decimal string
 *  AnchorResult.sequenceNumber already carries (see
 *  packages/anchor/src/topic.ts's SubmitHashResult). */
export interface DecisionReceiptRef {
  readonly nonce: string;
  readonly topicId: string;
  readonly sequenceNumber: string;
}

/**
 * Structurally binds a filed receipt to the decision that authorized it —
 * closes Build Kit B2/B3. Today that link exists only as a human-readable
 * string inside decideAndBuy()'s own thrown purchase-failure error message
 * ("Decision <nonce> was anchored at consensus ... but the purchase
 * failed"); nothing structured and independently-checkable connects the two.
 *
 * Deliberately a small, pure function taking the three fields it needs
 * rather than a whole Decision/AnchorResult object: it has no opinion on
 * where those fields come from, keeps `topicId` and `sequenceNumber`
 * REQUIRED (unlike AnchorResult's own optional fields) so a receipt can
 * never be silently linked to a decision whose anchor didn't actually reach
 * consensus with a recorded sequence number, and stays trivially testable
 * without constructing a real Decision or AnchorResult. Wiring this into
 * scripts/e2e.ts's buildReceipt() is a later, separate follow-up -- this is
 * the primitive that follow-up will call.
 *
 * That future caller CANNOT get there by narrowing on `outcome === "purchased"`
 * alone: AnchorResult.topicId and AnchorResult.sequenceNumber are both
 * optional (`?: string`), and TypeScript does not narrow a nested sibling
 * field's optionality from a discriminant on `outcome` -- under this repo's
 * `strict: true`, `{ topicId: anchor.topicId, sequenceNumber:
 * anchor.sequenceNumber }` still typechecks as `string | undefined` for both,
 * which does not satisfy DecisionReceiptRef's required `string` fields. The
 * caller needs its own explicit runtime guard, e.g.:
 *   if (result.outcome === "purchased" && result.anchor.topicId && result.anchor.sequenceNumber) {
 *     linkReceiptToDecision(receipt, {
 *       nonce: result.decision.nonce,
 *       topicId: result.anchor.topicId,
 *       sequenceNumber: result.anchor.sequenceNumber,
 *     });
 *   }
 * and must decide what to do in the (defensive-only -- anchor.ok true always
 * sets both fields today) case where that guard fails: skip the link rather
 * than call linkReceiptToDecision() with a fabricated value.
 */
export function linkReceiptToDecision(
  receipt: Record<string, unknown>,
  ref: DecisionReceiptRef,
): Record<string, unknown> {
  return {
    ...receipt,
    decision: { nonce: ref.nonce, topicId: ref.topicId, sequenceNumber: ref.sequenceNumber },
  };
}
