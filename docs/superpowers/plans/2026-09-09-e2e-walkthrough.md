# Implement `scripts/e2e.ts` — the real end-to-end demo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `scripts/e2e.ts` from a stub into the real, runnable `npm run e2e` demo — steps 1–6 of the README's "Verify it yourself" list, live against real testnet infrastructure, plus a live decline demonstration (E3). Step 7 is cut, not faked.

**Architecture:** One script, `scripts/e2e.ts`, with a small set of exported pure/DI-seamed helpers (unit-tested) and one un-unit-tested `main()` that orchestrates two real `decideAndBuy()` calls (approval + decline), a post-purchase receipt anchor, and independent verification — printing concrete evidence at every step.

**Tech Stack:** TypeScript, no build step, Node ≥ 24, Vitest, `@proof-of-spend/{anchor,buyer,verifier}` workspace packages (each resolves via `package.json`'s `"main": "src/index.ts"`, confirmed), `scripts/decide-and-buy.ts` + `scripts/check-budget-live.ts` (both already correct on disk, unmodified by this plan).

---

## Context

The README's "## Run it" section promises exactly this: `git clone`, `npm ci`, `npm run e2e`. That is the literal command an ETHOnline judge will type. Right now it throws `not implemented`. With roughly a week left in the build window, this is the one remaining gap between "every piece is built and tested in isolation" and "the submission's central claim is reproducible by someone who isn't us."

This also closes two items from an internal requirements audit against the original Build Kit spec: **E3** (the demo must show a live decline, not only an approval) and **G1** (one command seeds nothing and walks the loop). Both were unmet only because this file was a stub — `decideAndBuy()` already anchors declines with the same rigor as approvals (E1/E2 are already met by `scripts/decide-and-buy.ts`), and `createLiveCheckBudget()` already exists and is tested. Nothing new needs to be built in the packages; this is pure orchestration.

Two decisions are already made upstream and are fixed inputs to this plan, not open questions:

1. **Nominal 1 HBAR = $1.00, disclosed.** `check_budget` requires a positive fiat `amount`, but `packages/store/src/menu.ts` has only tinybar prices, and there is no real USD price anywhere in this repo. Rather than a real (illegible, misleadingly-precise) HBAR/USD rate, this plan uses a deliberately fake, disclosed 1:1 rate so a judge can read `priceTinybar` straight off the menu and predict the dollar amount: espresso `15_000_000n` → $0.15, flat-white `25_000_000n` → $0.25, cold-brew `35_000_000n` → $0.35.
2. **A real, human-provisioned budget rule**, created out-of-band on the shared `askReceipts` demo account before this ships — not something `e2e.ts` creates at runtime (mutating shared/public credential state at runtime would collide across concurrent judge runs). This plan's decline demo depends on it; see the Prerequisite section below.

---

## PREREQUISITE — required before a live run can fully succeed (does not block writing/committing this code)

Before `npm run e2e` can demonstrate a real decline, a human must create this budget rule on the `askReceipts` demo account (the same account `ASKRECEIPTS_AGENT_KEY` authenticates as), via `create_budget` or equivalent:

> **description:** `"Refuse any agent purchase on the hedera-proof-of-spend store over $0.30."`
> **enforcement:** `"refuse"`

Calibration, and why this exact wording: at the nominal 1 HBAR = $1.00 rate, the three menu items price at $0.15 (espresso), $0.25 (flat-white), $0.35 (cold-brew). A threshold strictly between $0.25 and $0.35 makes exactly one item (cold-brew) decline and at least one (espresso, this plan's chosen approval item) reliably approve — $0.30 sits in the middle of that gap with margin on both sides. The wording says **"hedera-proof-of-spend store"** deliberately, matching (verbatim) the `merchant` field this plan's `describePurchase` sends with every `check_budget` call, to reduce the chance `askReceipts`' NLU rule-matching scopes the rule differently than intended.

`enforcement: "refuse"` is required, not `"warn"` or `"notify"`: `"notify"` is alert-only and can never produce a blocking decision — `check_budget` would return `decision: "allow"` regardless, and cold-brew would simply purchase. `"warn"` would also work mechanically (`mapResult()` in `check-budget-live.ts` fails closed on `"warn"` too), but `"refuse"` is the semantically honest choice for a real decline demonstration and is `create_budget`'s own default.

If this rule is not yet in place when `npm run e2e` is run, the script will not crash — see the Verification section below for exactly what a judge sees in that case, and Task 2's anomaly handling.

---

## Global Constraints

- `.ts` extensions on all of this repo's own relative imports; no build step; Node ≥ 24; test runner is Vitest (`vitest run` / `npm test`); test files are file-adjacent `*.test.ts`.
- Error messages name what's wrong and the offending value (established voice throughout `packages/buyer`, `packages/anchor`, `scripts/decide-and-buy.ts`, `scripts/check-budget-live.ts`).
- Keep the `export {};` module-scope guard (it exists so `main` doesn't collide with the verifier CLI's own `main`).
- Do not modify `scripts/decide-and-buy.ts`, `scripts/check-budget-live.ts`, any file under `packages/`, or `.env.example`.
- Do not implement step 7 (cross-rail total) in any form — no seeding infrastructure exists anywhere in this repo (confirmed by exhaustive search); cut it, per `docs/design.md`'s Open Items and the file's own former TODO.
- Do not bake in a real `ASKRECEIPTS_AGENT_KEY` default value — require the env var, throw a clear, actionable error naming it if unset.
- `main()` is not unit-testable (live, credentialed, network-calling orchestration) and is not given fake unit tests — verified only by actually running it. Only pure/DI-seamed helper functions extracted from it are unit-tested, matching how every other network-touching function in this repo (`buyResource`, `createLiveCheckBudget`, `parseSettlement`, `hashReceipt`) is tested: via dependency injection, not mocking frameworks.
- Exit code 0 only on full success of the core proof (purchase, receipt anchor, independent verifier match) — mirrors `packages/verifier/src/cli.ts`'s own convention. A correctly-triggered decline is success, not failure, and must not be conflated with "something went wrong."
- Run `npm run typecheck` and `npm test` (full suite) at the end of every task.

**File structure decision:** everything lives in the single file `scripts/e2e.ts` — not split into a separate helpers module. Its tested pure/DI-seamed functions (`tinybarToNominalUsd`, `fetchMenu`, `buildDescribePurchase`, `buildReceipt`, `slugFromResource`) are exported from it and tested from `scripts/e2e.test.ts`, the same file-adjacent pattern as `scripts/check-budget-live.test.ts`.

---

## Task 1: Pure and DI-seamed helpers, with tests

**Files:**
- Modify: `scripts/e2e.ts` (helpers only — `main()` comes in Task 2)
- Create: `scripts/e2e.test.ts`

**Interfaces:**
- Consumes: `BudgetCheckRequest` (`import type` from `./decide-and-buy.ts`); `DescribePurchase`, `CheckBudgetPurchase` (`import type` from `./check-budget-live.ts`); `BuyResult` (`import type` from `@proof-of-spend/buyer`).
- Produces (for Task 2): `export function tinybarToNominalUsd(priceTinybar: bigint): number`; `export interface MenuItemPrice { slug, name, priceTinybar }`; `export async function fetchMenu(baseUrl: string, fetchImpl?: typeof fetch): Promise<Map<string, MenuItemPrice>>`; `export function slugFromResource(resource: string): string`; `export function buildDescribePurchase(menu: ReadonlyMap<string, MenuItemPrice>): DescribePurchase`; `export function buildReceipt(slug: string, purchase: BuyResult): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/e2e.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildDescribePurchase,
  buildReceipt,
  fetchMenu,
  slugFromResource,
  tinybarToNominalUsd,
} from "./e2e.ts";
import type { MenuItemPrice } from "./e2e.ts";
import type { BuyResult } from "@proof-of-spend/buyer";

describe("tinybarToNominalUsd", () => {
  it("prices the menu's three real amounts at the nominal 1 HBAR = $1.00 rate", () => {
    expect(tinybarToNominalUsd(15_000_000n)).toBe(0.15); // espresso
    expect(tinybarToNominalUsd(25_000_000n)).toBe(0.25); // flat-white
    expect(tinybarToNominalUsd(35_000_000n)).toBe(0.35); // cold-brew
  });

  it("throws on a non-positive amount rather than silently pricing it at zero", () => {
    expect(() => tinybarToNominalUsd(0n)).toThrow(/non-positive/);
    expect(() => tinybarToNominalUsd(-1n)).toThrow(/non-positive/);
  });
});

describe("slugFromResource", () => {
  it("extracts the last path segment as the menu slug", () => {
    expect(slugFromResource("https://store.example/buy/espresso")).toBe("espresso");
  });

  it("throws on a URL with no path segments", () => {
    expect(() => slugFromResource("https://store.example/")).toThrow(/Cannot determine/);
  });
});

describe("fetchMenu", () => {
  const fakeMenuResponse = (): Response =>
    new Response(
      JSON.stringify({
        items: [
          { slug: "espresso", name: "Espresso", priceTinybar: "15000000" },
          { slug: "cold-brew", name: "Cold brew", priceTinybar: "35000000" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("parses the store's real menuPayload() shape into a slug-keyed map of bigint prices", async () => {
    const fetchImpl = (async () => fakeMenuResponse()) as typeof fetch;
    const menu = await fetchMenu("https://store.example", fetchImpl);
    expect(menu.get("espresso")).toEqual({
      slug: "espresso",
      name: "Espresso",
      priceTinybar: 15_000_000n,
    });
    expect(menu.get("cold-brew")?.priceTinybar).toBe(35_000_000n);
  });

  it("throws on a non-2xx response, naming the status", async () => {
    const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(fetchMenu("https://store.example", fetchImpl)).rejects.toThrow(/503/);
  });

  it("throws on a 200 with no items[] array", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    await expect(fetchMenu("https://store.example", fetchImpl)).rejects.toThrow(/items/);
  });
});

describe("buildDescribePurchase", () => {
  const menu: ReadonlyMap<string, MenuItemPrice> = new Map([
    ["espresso", { slug: "espresso", name: "Espresso", priceTinybar: 15_000_000n }],
  ]);

  it("looks up the slug from the resource URL and prices it at the nominal rate", () => {
    const describePurchase = buildDescribePurchase(menu);
    const purchase = describePurchase({
      agent: "agent",
      resource: "https://store.example/buy/espresso",
    });
    expect(purchase.amount).toBe(0.15);
    expect(purchase.currency).toBe("USD");
    expect(purchase.merchant).toBe("hedera-proof-of-spend store");
  });

  it("throws naming the slug when the resource isn't in the fetched menu", () => {
    const describePurchase = buildDescribePurchase(menu);
    expect(() =>
      describePurchase({ agent: "agent", resource: "https://store.example/buy/unknown-item" }),
    ).toThrow(/unknown-item/);
  });
});

describe("buildReceipt", () => {
  it("builds a hash-spec-compliant receipt: numbers as decimal strings, keys unsorted (the hasher sorts them)", () => {
    const purchase: BuyResult = {
      body: { ok: true },
      amountTinybar: 15_000_000n,
      settlement: {
        transactionId: "0.0.12345@1699999999.123456789",
        feePayer: "0.0.12345",
        validStartSeconds: 1699999999,
        validStartNanos: 123456789,
      },
    };
    const receipt = buildReceipt("espresso", purchase);
    expect(receipt).toEqual({
      rail: "hedera",
      item: { slug: "espresso" },
      amountTinybar: "15000000",
      settlement: {
        transactionId: "0.0.12345@1699999999.123456789",
        feePayer: "0.0.12345",
        validStartSeconds: "1699999999",
        validStartNanos: "123456789",
      },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/e2e.test.ts`
Expected: FAIL — none of `tinybarToNominalUsd`, `fetchMenu`, `slugFromResource`, `buildDescribePurchase`, `buildReceipt`, `MenuItemPrice` are exported from `scripts/e2e.ts` yet.

- [ ] **Step 3: Implement the helpers**

Add to `scripts/e2e.ts` (below the imports, above `main`):

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/e2e.test.ts`
Expected: PASS, all cases above.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: both clean — no new errors, no regressions in `scripts/decide-and-buy.test.ts` or `scripts/check-budget-live.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/e2e.ts scripts/e2e.test.ts
git commit -m "feat: e2e helpers -- nominal pricing, live menu fetch, receipt shape"
```

---

## Task 2: `main()` — the real orchestration

**Files:**
- Modify: `scripts/e2e.ts`

**Interfaces:**
- Consumes everything from Task 1, plus: `assertTestnet`, `hashscanUrl` (`@proof-of-spend/buyer`); `anchorReceipt` (`@proof-of-spend/anchor`); `verify` (`@proof-of-spend/verifier`); `decideAndBuy` + `DecideAndBuyResult` type (`./decide-and-buy.ts`); `createLiveCheckBudget` (`./check-budget-live.ts`).
- Produces: the runnable `npm run e2e` entry point. Nothing later depends on this task.

**Verified before writing this task:** all three workspace packages resolve `"main": "src/index.ts"` in their `package.json` (confirmed directly), so the import statements below resolve correctly. `verify()`'s `network` parameter genuinely defaults to `"testnet"` when omitted (`const network = opts.network ?? "testnet";`, confirmed directly in `packages/verifier/src/index.ts`) — `verify(receipt, { topicId })` below is correct as written.

- [ ] **Step 1: Replace the stub's `main()` and top-of-file comment with the real implementation**

Replace the entire current top-of-file comment block and `main()`/bottom of `scripts/e2e.ts` with:

```ts
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
```

Note: this depends on Task 1's helpers (`fetchMenu`, `buildDescribePurchase`, `buildReceipt`, `TINYBAR_PER_HBAR`, `formatHbar` uses it) already being present in the same file above `main()` — they are, from Task 1, Step 3.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: clean, including Task 1's new tests and every pre-existing test file.

- [ ] **Step 4: Manually verify by running the real thing**

With `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, and `ASKRECEIPTS_AGENT_KEY` set to real testnet/demo credentials in `.env` (or exported in the shell) and — ideally — the Prerequisite budget rule already created:

```bash
npm run e2e
```

Confirm in the output (see the Verification section below for the full expected shape):
- Step 1 prints a `verdict: approved` for espresso, plus a decision-anchor hash/topic with `ok=true`.
- Step 2 prints a real HBAR amount, a real Hedera transaction id, and a real `hashscan.io/testnet/transaction/...` link.
- The decline-demonstration block prints `verdict: declined` for cold-brew (if the prerequisite rule is in place) with a `budgetRuleId`/`reason`, and "Decline demonstration succeeded."
- Step 3 prints the receipt JSON with `amountTinybar` and `settlement.validStartSeconds`/`validStartNanos` as strings, not numbers.
- Step 4 prints a hash, the topic id, and `anchored: true`.
- Step 5 prints `outcome: match` and a consensus timestamp.
- Step 6 prints a `hashscan.io/testnet/topic/<id>/messages` link.
- Step 7's block explicitly states it was cut, not silently skipped.
- The process exits 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e.ts
git commit -m "feat: implement the real e2e walkthrough (steps 1-6, live decline demo)"
```

---

## Verification (full expectations, including the "rule not set up yet" case)

Run `npm run e2e` with real credentials.

**If the prerequisite rule is in place:** exit code 0; espresso purchases; cold-brew declines with a printed `budgetRuleId` and `reason`; steps 3–6 run against the espresso receipt; step 5 prints `outcome: match`; step 6 prints a real HashScan topic-messages URL.

**If the prerequisite rule is NOT yet in place:** `check_budget` has no rule to refuse anything, so cold-brew will also return `allow`/`purchased`. The script does not crash: it prints, clearly, under the "Decline demonstration" section, an `ANOMALY:` block naming what was expected vs. what happened and pointing at the Prerequisite section's exact wording — then continues through steps 3–6 on the espresso purchase already captured, still exiting 0 if verification matches. This is diagnosable at a glance — never a bare stack trace or a silent false claim.

**If credentials are missing:** `requireEnv` throws immediately, e.g. `ASKRECEIPTS_AGENT_KEY is not set. See .env.example.`, caught by the top-level `.catch`, printed, exit 1 — before any network call.

**If `HEDERA_NETWORK` is set to anything but `testnet`:** `assertTestnet` throws before any credential is used.

**If the store's `/menu` is unreachable:** `fetchMenu` throws naming the status code, caught by the top-level `.catch`, exit 1, before any purchase is attempted.

## What This Plan Does NOT Do

- Does not implement step 7 (cross-rail total) in any form, simulated or otherwise.
- Does not modify `scripts/decide-and-buy.ts`, `scripts/check-budget-live.ts`, or any file under `packages/`.
- Does not bake in a real `ASKRECEIPTS_AGENT_KEY` default/demo-token value — that remains an explicitly separate, later follow-up once the human supplies the real public token.
- Does not attempt to make the verifier's dead `"altered"` branch reachable — that is an accepted, deliberate design limitation (no correlator in the anchored message, a privacy choice), not something this slice touches.
- Does not build any seeding script or infrastructure for x402/MPP receipts.
- Does not write unit tests for `main()` itself — it is exercised only by actually running `npm run e2e` against real infrastructure, per this repo's own precedent (`packages/buyer/src/cli.ts` has no test file for the same reason).

### Critical Files for Implementation
- `scripts/e2e.ts`
- `scripts/e2e.test.ts`
- `scripts/decide-and-buy.ts` (reference, unmodified)
- `scripts/check-budget-live.ts` (reference, unmodified)
- `README.md` (reference, unmodified)
