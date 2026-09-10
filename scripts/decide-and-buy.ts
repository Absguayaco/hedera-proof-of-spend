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
 */
import { randomUUID } from "node:crypto";
import { anchorReceipt } from "@proof-of-spend/anchor";
import type { AnchorResult } from "@proof-of-spend/anchor";
import { buyResource } from "@proof-of-spend/buyer";
import type { BuyResult } from "@proof-of-spend/buyer";

export interface Decision {
  readonly agent: string;
  readonly resource: string;
  readonly verdict: "approved" | "declined";
  readonly budgetRuleId?: string;
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
  buyResourceImpl: typeof buyResource = buyResource,
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

  const decision: Decision = {
    agent: request.agent,
    resource: request.resource,
    verdict: budget.verdict,
    budgetRuleId: budget.budgetRuleId,
    reason: budget.reason,
    // Fresh on every call -- see this file's top doc comment ("Build Kit
    // B6") for why that alone is enough to close the nonce-replay concern
    // without a separate replay-check.
    nonce: randomUUID(),
    decidedAt: new Date().toISOString(),
  };

  // The decision is anchored HERE, unconditionally, before its verdict is
  // ever inspected — a decline goes through the identical call an approval
  // would (E1: same rigor, no special-casing).
  const anchor = await anchorReceiptImpl(decision, {
    operatorId: request.operatorId,
    operatorKey: request.operatorKey,
    topicId: request.topicId,
  });

  if (!anchor.ok) {
    // A1: no payment settles unless its decision is already at consensus —
    // if we can't even confirm the anchor, we refuse to buy.
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
    // Inverted, not `=== "declined"`: checkBudget's response is untrusted
    // (see CheckBudget's doc comment), so anything that isn't exactly
    // "approved" is treated as a refusal — never the reverse. E2: a decline
    // (or an unrecognized verdict) settles nothing.
    return { outcome: "declined", decision, anchor };
  }

  try {
    const purchase = await buyResourceImpl({
      url: request.resource,
      operatorId: request.operatorId,
      operatorKey: request.operatorKey,
    });
    return { outcome: "purchased", decision, anchor, purchase };
  } catch (error) {
    // The decision was genuinely anchored at consensus by this point — this
    // is a real payment failure, not a budget decline, so it is not folded
    // into DecideAndBuyResult next to "declined". buyResource()'s own throw
    // contract is preserved for this caller too, just decorated with the
    // context that anchoring already succeeded.
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
