# Anchor-Before-Pay Decision Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, additive pre-payment gate — anchor a spend *decision* to HCS and only pay if that anchor genuinely reaches consensus — closing an architectural gap (A1/E1/E2) flagged against an external hackathon judging spec, without changing anything already shipped.

**Architecture:** One new root-level module, `scripts/decide-and-buy.ts`, orchestrating in front of the already-merged `packages/anchor` and `packages/buyer` — both consumed completely unmodified. `decideAndBuy()` calls an injected `checkBudget`, builds a `Decision`, anchors it via the existing `anchorReceipt()` (which already accepts any canonicalizable JSON, and whose `submitHash` genuinely blocks on real HCS consensus), and only calls `buyResource()` if that anchor succeeded and the verdict was `"approved"`. A decline goes through the identical anchor call an approval would — no special-casing.

**Tech Stack:** TypeScript (Node ≥ 24, no build step), reuses `@proof-of-spend/anchor` and `@proof-of-spend/buyer` as workspace-name imports, Vitest.

## Context

An external hackathon judging spec ("Build Kit," pasted by the human partner — not present anywhere in this repo) flags a real architectural gap: it requires **"no payment may settle unless its decision is already at consensus"** (A1, load-bearing), that **a decline must be anchored with the same rigor as an approval** (E1), and that **a decline must settle nothing** (E2). This repo's current, shipped, documented design is the opposite — pay first, anchor a receipt afterward, best-effort, with an explicitly "advisory" budget guard that "can ask permission, be refused, and buy anyway."

Verified against current `main` before this plan (most of a separately-pasted "Requirement Ledger" audit was stale — `parseSettlement`, `verify()`, the verifier CLI, and `createTopic`/`submitHash` are all fully implemented and merged, contrary to what that document claimed): the A1/E1/E2 gap is real, not stale. Confirmed with the human partner: resolve it for real, not just document the disagreement — and do it additively, reusing the existing, deliberately generic anchor/verify primitives rather than rearchitecting anything already shipped.

**Key enabling fact, verified against the actual merged code:** `packages/anchor/src/index.ts#anchorReceipt(receipt: unknown, opts, hcs?)` was never restricted to a fixed "receipt" shape — it accepts any canonicalizable JSON object. And its `submitHash` call genuinely blocks on real HCS consensus (`.getReceipt(client)` throws on a non-SUCCESS status — this is exactly the property a prior review round fixed and confirmed). So anchoring a *decision* instead of a *receipt* needs zero changes to `packages/anchor`, `packages/buyer`, or `packages/verifier` — this plan is purely new orchestration in front of them.

**Explicitly out of scope, confirmed with the human partner:**
- The real askReceipts MCP integration. Nothing in this repo or its git history defines askReceipts' real `check_budget` tool schema (confirmed via exhaustive search), and the live endpoint requires full OAuth with no accessible credential (confirmed live: `POST /api/mcp` → `401 invalid_token`). The budget-check boundary is designed as an injectable dependency instead, so this plan is fully buildable and testable now.
- A3/A7 (nanosecond-ordering verification logic in `packages/verifier`) — a detection concern, separable from A1's prevention concern, which this plan satisfies structurally without it.
- B6 (nonce-replay enforcement) — a nonce is generated and anchored, making each decision uniquely identifiable, but nothing here checks for a prior identical nonce. Disclosed limitation, not silently assumed away.
- `scripts/e2e.ts`'s full seven-step implementation, and any README rewrite (though one is now warranted — noted for the human partner, not a task here).

## Global Constraints

- Reuse `packages/anchor`'s `anchorReceipt`/`AnchorResult` and `packages/buyer`'s `buyResource`/`BuyResult` completely unmodified. Import them by workspace package name (`@proof-of-spend/anchor`, `@proof-of-spend/buyer`) — verified live that both resolve correctly from the repo root via npm workspace hoisting (`node -e 'import("@proof-of-spend/anchor")'` lists `anchorReceipt` among its exports; same for `@proof-of-spend/buyer` and `buyResource`).
- Every `Decision` field must be a canonicalizable value (string/boolean/null/array/plain-object only, per `packages/anchor/src/hash.ts`'s rule) — no numbers, no `Date` objects. Verified: `hash.ts`'s `canonicalValue()` already omits a key whose value is `undefined` regardless of whether it was explicitly assigned or never set (`if (entry === undefined) continue`), so optional `Decision` fields can be assigned directly from a budget-check response with no conditional-spread ceremony.
- DI convention matches this repo's existing pattern (`fetchImpl: typeof fetch = fetch` in buyer/verifier, `hcs: HcsOps = {...}` in anchor) — **with one deliberate deviation**: `checkBudget` has NO default. Every other seam in this repo defaults to a *real* implementation; there is no real `checkBudget` to default to, and a fake "always approve" default would be the single most dangerous thing to leave in place in a gate whose entire purpose is refusing to buy. Every caller must supply one explicitly.
- `anchorReceiptImpl`/`buyResourceImpl` are injected as whole functions (matching the granularity one level down: `anchorReceipt` itself injects `HcsOps`, not `Client` construction beneath it) — so this module's own tests need no fake mirror-node pages or fake 402 challenges; those are already covered by `packages/anchor`'s and `packages/buyer`'s own test suites.
- `anchorReceipt()` never throws (best-effort by design); `buyResource()` always throws on failure (its own doc comment requires callers to `try/catch`). This plan's `decideAndBuy()` combines both — a `buyResourceImpl` throw is caught and rethrown decorated with `{ cause }`, not swallowed into a return value, matching the existing precedent in `packages/store/src/preflight.ts` (`throw new Error(..., { cause })`) — verified this pattern exists in the current codebase, not invented for this plan.
- No new `package.json`, no root script needed. `tsconfig.json`'s `include` already covers `"scripts/**/*.ts"`.
- `.ts` extensions in relative imports. No build step, Node >= 24. Vitest, file-adjacent `*.test.ts`.

---

### Task 1: `scripts/decide-and-buy.ts` — `Decision`, `CheckBudget`, `decideAndBuy()`

**Files:**
- New: `scripts/decide-and-buy.ts`
- New: `scripts/decide-and-buy.test.ts`

**Interfaces:**
- Consumes: `anchorReceipt`, `AnchorResult` from `@proof-of-spend/anchor` (done, unmodified). `buyResource`, `BuyResult` from `@proof-of-spend/buyer` (done, unmodified). `randomUUID` from `node:crypto`.
- Produces: `Decision`, `BudgetCheckRequest`, `BudgetCheckResponse`, `CheckBudget`, `DecideAndBuyRequest`, `DecideAndBuyResult`, `decideAndBuy()`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/decide-and-buy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import type { BuyResult } from "@proof-of-spend/buyer";
import type { CheckBudget, Decision } from "./decide-and-buy.ts";
import { decideAndBuy } from "./decide-and-buy.ts";

const AGENT = "agent-demo";
const RESOURCE = "http://localhost:8402/buy/espresso";

const REQUEST = {
  agent: AGENT,
  resource: RESOURCE,
  operatorId: "0.0.99999",
  // Opaque in every test below — never parsed by a real anchorReceipt/buyResource,
  // both of which are replaced with fakes, so this does not need to be a real key.
  operatorKey: "fake-operator-key",
};

function approve(overrides: Partial<Awaited<ReturnType<CheckBudget>>> = {}): CheckBudget {
  return async () => ({ verdict: "approved", budgetRuleId: "daily-cap", ...overrides });
}

function decline(reason = "over the daily cap"): CheckBudget {
  return async () => ({ verdict: "declined", budgetRuleId: "daily-cap", reason });
}

function fakeAnchor(result: AnchorResult) {
  const received: unknown[] = [];
  const order: string[] = [];
  const impl = (async (receipt: unknown) => {
    received.push(receipt);
    order.push("anchor");
    return result;
  }) as Parameters<typeof decideAndBuy>[2];
  return { impl, received, order };
}

function fakeBuy(result: BuyResult | Error, order: string[] = []) {
  const calls: unknown[] = [];
  const impl = (async (request: unknown) => {
    calls.push(request);
    order.push("buy");
    if (result instanceof Error) throw result;
    return result;
  }) as Parameters<typeof decideAndBuy>[3];
  return { impl, calls };
}

const OK_ANCHOR: AnchorResult = { ok: true, hash: "a".repeat(64), topicId: "0.0.777" };
const FAILED_ANCHOR: AnchorResult = { ok: false, hash: "a".repeat(64), error: "mirror node unreachable" };
const PURCHASE: BuyResult = {
  body: { item: { slug: "espresso" } },
  amountTinybar: 15_000_000n,
  settlement: { transactionId: "0.0.99999@1700000000.123456789", feePayer: "0.0.11111", seconds: 1700000000, nanos: 123456789 },
};

describe("decideAndBuy", () => {
  it("refuses to buy when the decision cannot be confirmed at HCS consensus", async () => {
    const anchor = fakeAnchor(FAILED_ANCHOR);
    const buy = fakeBuy(PURCHASE);

    const result = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(result.outcome).toBe("anchor_failed");
    expect(result.anchor).toEqual(FAILED_ANCHOR);
    if (result.outcome === "anchor_failed") {
      expect(result.message).toMatch(/could not be confirmed at HCS consensus/);
      expect(result.message).toMatch(/mirror node unreachable/);
    }
    // A1: no payment settles unless the decision behind it is already anchored.
    expect(buy.calls).toHaveLength(0);
  });

  it("anchors a decline with the same call an approval would get, and buys nothing", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR);
    anchor.order = order;
    const buy = fakeBuy(PURCHASE, order);

    const result = await decideAndBuy(REQUEST, decline("over the daily cap"), anchor.impl, buy.impl);

    expect(result.outcome).toBe("declined");
    // E1: the decline really was anchored — same rigor as an approval, no
    // special-casing. Proven by asserting the anchor's own {ok:true} result
    // is present, not merely that decideAndBuy claims to have anchored it.
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("declined");
    expect(result.decision.reason).toBe("over the daily cap");
    expect(result.decision.budgetRuleId).toBe("daily-cap");
    expect(anchor.received).toHaveLength(1);
    expect((anchor.received[0] as Decision).verdict).toBe("declined");
    // E2: a decline settles nothing.
    expect(buy.calls).toHaveLength(0);
  });

  it("buys after an approved decision is genuinely anchored", async () => {
    const order: string[] = [];
    const anchor = fakeAnchor(OK_ANCHOR);
    anchor.order = order;
    const buy = fakeBuy(PURCHASE, order);

    const result = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(result.outcome).toBe("purchased");
    expect(result.anchor).toEqual(OK_ANCHOR);
    expect(result.decision.verdict).toBe("approved");
    if (result.outcome === "purchased") {
      expect(result.purchase).toEqual(PURCHASE);
    }
    expect(buy.calls).toHaveLength(1);
    expect(buy.calls[0]).toEqual({
      url: RESOURCE,
      operatorId: REQUEST.operatorId,
      operatorKey: REQUEST.operatorKey,
    });
    // Anchor-then-pay, not the other way around.
    expect(order).toEqual(["anchor", "buy"]);
  });

  it("generates a fresh nonce and an ISO decidedAt timestamp on every call", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(PURCHASE);

    const first = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);
    const second = await decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(() => new Date(first.decision.decidedAt).toISOString()).not.toThrow();
    expect(new Date(first.decision.decidedAt).toISOString()).toBe(first.decision.decidedAt);
  });

  it("decorates a purchase failure with the already-anchored decision, and preserves the cause", async () => {
    const anchor = fakeAnchor(OK_ANCHOR);
    const buy = fakeBuy(new Error("insufficient_funds"));

    const attempt = decideAndBuy(REQUEST, approve(), anchor.impl, buy.impl);

    await expect(attempt).rejects.toThrow(/was anchored at consensus/);
    await expect(attempt).rejects.toThrow(/insufficient_funds/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe("insufficient_funds");
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- scripts/decide-and-buy.test.ts`
Expected: FAIL — `./decide-and-buy.ts` does not exist yet.

- [ ] **Step 3: Implement**

Create `scripts/decide-and-buy.ts`:

```ts
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
 * request/response schema, and the live endpoint requires OAuth this project
 * has no credential for. This is this module's own minimal guess at a
 * generic shape — injectable so the gating logic is fully testable now, with
 * the real wiring deferred to a later scripts/e2e.ts slice. Do not treat
 * this as ground truth.
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
  const budget = await checkBudget({ agent: request.agent, resource: request.resource });

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

  if (decision.verdict === "declined") {
    // E2: a decline settles nothing.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- scripts/decide-and-buy.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full suite, unaffected packages untouched**

```bash
npm test
node scripts/check-verifier-independence.mjs
```

Expected: full suite green (baseline + 5 new tests); independence guard still reports only `@hiero-ledger/sdk` — this plan never touches `packages/verifier/package.json`.

- [ ] **Step 7: Commit**

```bash
git add scripts/decide-and-buy.ts scripts/decide-and-buy.test.ts
git commit -m "feat: anchor-before-pay decision gate (decideAndBuy)"
```

---

### Task 2: Manual verification against real testnet

Needs a real, funded Hedera testnet account (same pattern as prior plans' manual-verification tasks). Demonstrates the ordering constraint holds against real HCS consensus and a real store purchase, using a hand-written stub in place of the (out-of-scope) real `checkBudget`.

- [ ] **Step 1: Approved path**

```bash
node -e '
import("./scripts/decide-and-buy.ts").then(async ({ decideAndBuy }) => {
  const request = {
    agent: "manual-verification-agent",
    resource: "https://hedera-proof-of-spend-store.vercel.app/buy/espresso",
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
  };
  const checkBudget = async () => ({ verdict: "approved", budgetRuleId: "manual-test" });
  const result = await decideAndBuy(request, checkBudget);
  console.log(JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
});
'
```

Confirm `result.outcome === "purchased"`, `result.anchor.ok === true`, a new topic id is printed.

- [ ] **Step 2: Confirm on HashScan**

Open `https://hashscan.io/testnet/topic/<topicId>/messages`, confirm a message exists.

- [ ] **Step 3: Confirm the existing, unmodified verifier works on a Decision unchanged**

Save `result.decision` to `./decision.json`:

```bash
HCS_TOPIC_ID=0.0.<topicId> npm run verify -- --receipt ./decision.json
```

Expected: `outcome: match` — proving `verify()` never needed to know about "decisions," only that its input is canonicalizable JSON.

- [ ] **Step 4: Declined path, same topic**

Rerun Step 1 with `checkBudget = async () => ({ verdict: "declined", reason: "manual test" })`. Confirm `result.outcome === "declined"`, a **new** HashScan message appears on the same topic (E1: the decline really was anchored), and no purchase output is printed (E2).

- [ ] **Step 5: Full suite + typecheck**

```bash
npm test
npm run typecheck
node scripts/check-verifier-independence.mjs
```

## Verification (whole plan)

1. `npm test` — full suite passes (baseline + 5 new tests).
2. `npm run typecheck` — clean.
3. `node scripts/check-verifier-independence.mjs` — unaffected, still clean.
4. Task 2's live run: anchor-fails-so-no-buy is provable only via the unit test (can't force a real HCS failure on demand) — but the declined-so-no-buy-yet-still-anchored and approved-so-buy-after-anchor paths both get proven against the real network, with the existing unmodified verifier confirming a Decision object round-trips through `anchorReceipt`/`verify` exactly like a receipt always has.

## What this plan does NOT do

- **A3/A7** (ordering-comparison logic in `packages/verifier`) — a detection concern, separable from A1's prevention concern, which this plan satisfies structurally.
- **B6** (nonce-replay enforcement) — a nonce is anchored per decision; nothing here checks the topic for a prior identical nonce. Disclosed limitation.
- **The real askReceipts MCP integration** — `CheckBudget` is a placeholder contract, not a verified schema.
- **`scripts/e2e.ts`'s full implementation** — this plan produces one importable function for it to eventually call.
- **Any change to `packages/anchor`, `packages/buyer`, or `packages/verifier`** — all three consumed exactly as they exist today.
- **README changes** — once `decideAndBuy()` exists, the "budget guard is advisory... it can ask permission, be refused, and buy anyway" claim is only true for a caller that bypasses this new gate and calls `buyResource()` directly. Worth revisiting, not done here — left to the human partner's judgment.
