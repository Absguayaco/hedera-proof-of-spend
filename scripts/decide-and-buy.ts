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
 * PLACEHOLDER CONTRACT. Stands in for askReceipts' real check_budget MCP
 * tool. Nothing in this repo or its history defines that tool's actual
 * request/response schema, and — while a real, tested client for it now
 * exists at scripts/check-budget-live.ts (Bearer-token auth, not OAuth as
 * this comment used to claim), verified live against the real server —
 * nothing in *this* file uses it yet. This is this module's own minimal
 * guess at a generic shape — injectable so the gating logic is fully
 * testable now, with the real wiring deferred to a later scripts/e2e.ts
 * slice. Do not treat this as ground truth.
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
