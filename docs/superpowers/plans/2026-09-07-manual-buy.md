# Manual buy from the store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/buyer` able to actually buy something from the store, and give a human a one-command way to trigger a real purchase by hand.

**Architecture:** Implement the two stubbed functions in `packages/buyer/src/settlement.ts` (parse/format the Hedera transaction reference), then implement `buyResource()` in `packages/buyer/src/index.ts` as an explicit, manually-orchestrated 402→pay→retry sequence (not `wrapFetchWithPayment`, so the project's existing, tested `assertChallengeNetwork` guard is what actually fires on a bad network quote). Add a thin CLI (`packages/buyer/src/cli.ts`) that calls it and prints the result. Filing receipts, HCS anchoring, verification, and the cross-rail total stay out of scope — this is just the buy step, made runnable on its own.

**Tech Stack:** TypeScript (Node 24, run directly with no build step), `@x402/core`, `@x402/hedera`, Vitest.

## Context

`packages/buyer`'s core function — actually paying for something — is a stub: `buyResource()` throws `"not implemented"`, and so do both functions in `settlement.ts`. There is currently no way to exercise a real purchase against the store. `scripts/e2e.ts` (the full seven-step demo) is a separate, larger piece of work with its own dependencies (askReceipts credentials, HCS topic setup); this plan implements just step 2 of that walkthrough (buy), made runnable on its own, ahead of the rest of the pipeline existing.

This plan is a companion to the approved design doc at `docs/superpowers/specs/2026-09-07-manual-buy-design.md`, committed on this branch. **One decision in that doc is superseded here:** the doc scopes the CLI to a hardcoded `http://localhost:8402` target, decided while the project's Vercel deployment was still unfinished (to stay decoupled from that concurrent work). That deployment is now live and public (`https://hedera-proof-of-spend-store.vercel.app`, confirmed in the current `README.md`, and already `.env.example`'s documented `STORE_URL` default). Re-confirmed with the user: the CLI should default to that hosted store and read `STORE_URL` as an override, matching the convention `.env.example` already documents and needing zero local setup to run — matching how `npm run verify` also needs no local infrastructure. Task 3 updates the design doc's paragraph to match before implementing the CLI.

## Global Constraints

- Node >= 24, npm >= 11.10.0 — no build step, TypeScript runs directly (`package.json` `engines`).
- Testnet only. `packages/buyer` signs from a raw private key supplied by whoever runs it; every payment must go through `assertChallengeNetwork()` (`packages/buyer/src/guard.ts`) before any signing happens — this is the load-bearing safety property of this package, not a stylistic preference.
- `packages/buyer` speaks exactly one rail (the Hedera exact scheme). No rail registry, no funding seam, nothing pluggable — don't generalize.
- Amounts are `bigint` tinybar, never floats, never HBAR decimals — same rule the store's `menu.ts` already follows.
- Match this repo's existing error-message convention: name what's wrong and the offending value (see `packages/store/src/config.ts`, `packages/buyer/src/guard.ts`).
- Test pure logic without a network, by injecting the collaborator the function depends on (see `packages/store/src/preflight.test.ts` injecting a fake `FacilitatorClient`; `packages/buyer/src/guard.test.ts` for the error-message-assertion style) — not by mocking globals where an injectable parameter will do.
- `main().catch((error) => { console.error(...); process.exitCode = 1; })` is this repo's CLI entry-point convention (`packages/verifier/src/cli.ts`) — no raw stack traces for expected failures.

---

### Task 1: Implement `settlement.ts` — parse and link a Hedera settlement reference

**Files:**
- Modify: `packages/buyer/src/settlement.ts` (currently both functions throw `"not implemented"`; the `HederaSettlement` interface and `TX_ID` regex already exist and don't change)
- Test: `packages/buyer/src/settlement.test.ts` (new)

**Interfaces:**
- Produces: `parseSettlement(raw: string): HederaSettlement` and `hashscanUrl(settlement: HederaSettlement): string`, both already declared as exports of this file. `HederaSettlement` is `{ transactionId: string; feePayer: string; seconds: number; nanos: number }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/buyer/src/settlement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashscanUrl, parseSettlement } from "./settlement.ts";

describe("parseSettlement", () => {
  it("parses a well-formed Hedera transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(settlement).toEqual({
      transactionId: "0.0.12345@1699999999.123456789",
      feePayer: "0.0.12345",
      seconds: 1699999999,
      nanos: 123456789,
    });
  });

  it("rejects a reference with no @", () => {
    expect(() => parseSettlement("0.0.12345")).toThrow(/Not a Hedera transaction id/);
  });

  it("rejects a reference with non-numeric seconds", () => {
    expect(() => parseSettlement("0.0.12345@abc.123")).toThrow(/Not a Hedera transaction id/);
  });

  it("names the offending value, so the error is actionable", () => {
    expect(() => parseSettlement("not-a-tx-id")).toThrow(/"not-a-tx-id"/);
  });
});

describe("hashscanUrl", () => {
  it("builds the testnet transaction link from the full transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/tx/0.0.12345@1699999999.123456789",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- settlement.test.ts`
Expected: FAIL — both `parseSettlement` and `hashscanUrl` throw `"not implemented"`.

- [ ] **Step 3: Implement**

In `packages/buyer/src/settlement.ts`, replace the two `throw new Error("not implemented")` bodies:

```ts
export function parseSettlement(raw: string): HederaSettlement {
  const match = TX_ID.exec(raw);
  if (!match) {
    throw new Error(
      `Not a Hedera transaction id (got "${raw}"). Expected payer@seconds.nanos, ` +
        `e.g. 0.0.12345@1699999999.123456789.`,
    );
  }
  const [, feePayer, seconds, nanos] = match;
  return { transactionId: raw, feePayer, seconds: Number(seconds), nanos: Number(nanos) };
}
```

```ts
/** HashScan URL for a transaction, so a receipt can link to third-party proof. */
export function hashscanUrl(settlement: HederaSettlement): string {
  return `https://hashscan.io/testnet/tx/${settlement.transactionId}`;
}
```

(Both replace the existing `_raw`/`_settlement`-parameter stub signatures; drop the leading underscore since the parameters are used now.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- settlement.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/buyer/src/settlement.ts packages/buyer/src/settlement.test.ts
git commit -m "feat(buyer): parse a Hedera settlement reference and link it on HashScan"
```

---

### Task 2: Implement `buyResource()` — pay the store's 402 challenge

**Files:**
- Modify: `packages/buyer/src/index.ts` (the `BuyRequest`/`BuyResult` interfaces and the trailing re-exports already exist and don't change; only the `buyResource` function body and its imports change)
- Modify: `packages/buyer/package.json` (drop the now-unused `@x402/fetch` dependency — nothing imports it, since this task orchestrates the 402 flow explicitly rather than using `wrapFetchWithPayment`)
- Test: `packages/buyer/src/index.test.ts` (new)

**Interfaces:**
- Consumes: `assertChallengeNetwork(network: string): void` and `ALLOWED_X402_NETWORK = "hedera:testnet"` from `./guard.ts` (existing); `parseSettlement(raw: string): HederaSettlement` from `./settlement.ts` (Task 1).
- Produces: `buyResource(request: BuyRequest, fetchImpl?: typeof fetch): Promise<BuyResult>` — the second parameter is new (defaults to the global `fetch`), added purely so tests can inject a fake HTTP layer without touching `globalThis`, matching this repo's existing dependency-injection testing style. `BuyRequest`/`BuyResult` shapes are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `packages/buyer/src/index.test.ts`:

```ts
import { PrivateKey } from "@x402/hedera";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { buyResource } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const PAY_TO = "0.0.54321";
const URL = "http://localhost:8402/buy/espresso";

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function paymentRequiredResponse(network: `${string}:${string}`): Response {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: URL },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: "0.0.0",
        amount: "15000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
  return new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodeHeader(paymentRequired) },
  });
}

function settledResponse(overrides: Partial<SettleResponse> = {}): Response {
  const settleResponse: SettleResponse = {
    success: true,
    transaction: "0.0.99999@1699999999.123456789",
    network: "hedera:testnet",
    ...overrides,
  };
  return new Response(JSON.stringify({ item: { slug: "espresso" } }), {
    status: 200,
    headers: { "PAYMENT-RESPONSE": encodeHeader(settleResponse) },
  });
}

describe("buyResource", () => {
  it("buys the resource end to end against a well-behaved store", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? paymentRequiredResponse("hedera:testnet") : settledResponse();
    }) as typeof fetch;

    const result = await buyResource(
      { url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fetchImpl,
    );

    expect(result.amountTinybar).toBe(15_000_000n);
    expect(result.settlement.transactionId).toBe("0.0.99999@1699999999.123456789");
    expect(result.body).toEqual({ item: { slug: "espresso" } });
  });

  it("refuses to pay when the store quotes a network other than hedera:testnet, before any payment is created", async () => {
    const fetchImpl = (async () => paymentRequiredResponse("hedera:mainnet")) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/Refusing to pay/);
  });

  it("surfaces the facilitator's reason when settlement fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return paymentRequiredResponse("hedera:testnet");
      return settledResponse({
        success: false,
        errorReason: "insufficient_funds",
        errorMessage: "balance too low",
      });
    }) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/insufficient_funds/);
  });

  it("reports the store's status when no settlement header comes back after payment", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return paymentRequiredResponse("hedera:testnet");
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/status 500/);
  });

  it("rejects a store that does not challenge with 402", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/expected 402/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- index.test.ts`
Expected: FAIL — `buyResource` throws `"not implemented"`.

- [ ] **Step 3: Implement**

Replace the contents of `packages/buyer/src/index.ts` with:

```ts
/**
 * A thin x402 client that speaks exactly one rail: the Hedera exact-payment
 * scheme, settling in native HBAR (0.0.0) through a hosted facilitator.
 *
 * This is deliberately NOT a general multi-rail buyer with the other rails
 * removed. There is no rail registry, no funding seam, and nothing pluggable.
 * If this file grows a second rail, the claim in the README stops being true.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactHederaScheme, PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ALLOWED_X402_NETWORK, assertChallengeNetwork } from "./guard.ts";
import { parseSettlement } from "./settlement.ts";
import type { HederaSettlement } from "./settlement.ts";

export interface BuyRequest {
  /** The x402-gated resource to fetch. */
  readonly url: string;
  readonly operatorId: string;
  readonly operatorKey: string;
}

export interface BuyResult {
  /** The resource body, once paid for. */
  readonly body: unknown;
  /** What the store charged, in tinybar, as quoted in the 402 challenge. */
  readonly amountTinybar: bigint;
  readonly settlement: HederaSettlement;
}

/**
 * Buys one resource: GET, expect 402, pay via the Hedera exact scheme, retry.
 *
 * Orchestrated explicitly rather than via `wrapFetchWithPayment` so that
 * `assertChallengeNetwork()` — this package's whole reason a raw private key
 * is acceptable to sign from — is what actually fires, with its specific
 * message, on a bad network quote. `wrapFetchWithPayment` would instead
 * surface a generic "no scheme registered" failure from `@x402/core`,
 * bypassing the guard entirely.
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests can inject a
 * fake HTTP layer without touching `globalThis`.
 */
export async function buyResource(
  request: BuyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<BuyResult> {
  const signer = createClientHederaSigner(
    request.operatorId,
    PrivateKey.fromString(request.operatorKey),
  );
  const client = new x402Client().register(ALLOWED_X402_NETWORK, new ExactHederaScheme(signer));
  const httpClient = new x402HTTPClient(client);

  const challenge = await fetchImpl(request.url);
  if (challenge.status !== 402) {
    throw new Error(`expected 402 from ${request.url}, got ${challenge.status}`);
  }

  const challengeBody = await challenge.json().catch(() => undefined);
  const paymentRequired: PaymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name),
    challengeBody,
  );

  const [quoted] = paymentRequired.accepts;
  if (!quoted) {
    throw new Error(`${request.url} did not quote a price`);
  }
  // Before any signer or key material is touched: the challenge is what
  // actually decides where the money goes, so it is checked separately from
  // whatever network the SDK happens to be configured for.
  assertChallengeNetwork(quoted.network);

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paid = await fetchImpl(request.url, { headers: paymentHeaders });

  let settleResponse: SettleResponse;
  try {
    settleResponse = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
  } catch (error) {
    throw new Error(
      `store did not return a settlement after payment (status ${paid.status}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  if (!settleResponse.success) {
    const reason = settleResponse.errorReason ?? "unknown";
    const detail = settleResponse.errorMessage ? ` — ${settleResponse.errorMessage}` : "";
    throw new Error(`payment failed: ${reason}${detail}`);
  }

  const settlement = parseSettlement(settleResponse.transaction);
  const amountTinybar = BigInt(quoted.amount);
  const body = await paid.json();

  return { body, amountTinybar, settlement };
}

export { assertTestnet, assertChallengeNetwork } from "./guard.ts";
export { parseSettlement, hashscanUrl } from "./settlement.ts";
export type { HederaSettlement } from "./settlement.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- index.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Drop the now-unused `@x402/fetch` dependency**

In `packages/buyer/package.json`, remove the `"@x402/fetch": "2.23.0"` line from `dependencies` (nothing in the package imports it once `buyResource` is hand-orchestrated).

Run: `npm install` (updates the lockfile for the workspace)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (baseline 181 + the 10 new from Tasks 1–2), no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/buyer/src/index.ts packages/buyer/src/index.test.ts packages/buyer/package.json package-lock.json
git commit -m "feat(buyer): implement buyResource against a store's 402 challenge"
```

---

### Task 3: A runnable CLI — `npm run buy -- [slug]`

**Files:**
- Create: `packages/buyer/src/cli.ts`
- Modify: `package.json` (root) — add a `"buy"` script next to the existing `"verify"` one
- Modify: `README.md` — document the CLI, in the same style as the existing `npm run verify` documentation
- Modify: `docs/superpowers/specs/2026-09-07-manual-buy-design.md` — update the CLI-target paragraph to match the re-confirmed decision (hosted default, `STORE_URL` override) instead of the original hardcoded-localhost one

**Interfaces:**
- Consumes: `buyResource(request: BuyRequest, fetchImpl?: typeof fetch): Promise<BuyResult>` and `hashscanUrl(settlement: HederaSettlement): string`, both from `./index.ts` (Task 2).

No new unit test file — this is a thin I/O entry point, the same convention `packages/verifier/src/cli.ts` already follows (untested directly; its logic lives in the tested `verify()` it calls). Verification is manual, in Step 4 below.

- [ ] **Step 1: Update the design doc's superseded paragraph**

In `docs/superpowers/specs/2026-09-07-manual-buy-design.md`, in the `packages/buyer/src/cli.ts (new)` bullet list, replace:

```
- Target is hardcoded to `http://localhost:8402/buy/<slug>` — no `STORE_URL`
  override in this CLI. (`STORE_URL` as documented in `.env.example` is for
  the future e2e script's hosted-by-default behavior; conflating the two
  would make this CLI's target ambiguous.)
```

with:

```
- Target defaults to the hosted store
  (`https://hedera-proof-of-spend-store.vercel.app`, matching `.env.example`'s
  documented `STORE_URL` default) and reads `STORE_URL` as an override — so
  `npm run buy` needs no local setup beyond testnet credentials, the same way
  `npm run verify` needs none. Set `STORE_URL=http://localhost:8402` to buy
  against a locally-run store instead.
```

Also update the "Out of scope / explicitly deferred" bullet `A STORE_URL override flag on this CLI (revisit once the e2e script needs the hosted-by-default behavior .env.example already documents)` — delete that bullet; it's now implemented, not deferred.

- [ ] **Step 2: Write the CLI**

Create `packages/buyer/src/cli.ts`:

```ts
/**
 * Standalone entry point: `npm run buy -- [slug]`
 *
 * Buys one item from the store by hand and prints what happened. No budget
 * check, no receipt filing, no anchoring — those belong to the larger e2e
 * walkthrough. This exists so a real purchase can be exercised and verified
 * on its own, against either the hosted store or a local one.
 */
import { buyResource, hashscanUrl } from "./index.ts";

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
```

- [ ] **Step 3: Wire up the script**

In root `package.json`, in `"scripts"`, add a line after `"verify"`:

```json
    "buy": "node packages/buyer/src/cli.ts",
```

- [ ] **Step 4: Document it in the README**

In `README.md`, add a new subsection right after `### Running it yourself` (inside `## The store`, before `## Deploying the store`):

```markdown
### Buying something by hand

    HEDERA_OPERATOR_ID=0.0.<your account> \
    HEDERA_OPERATOR_KEY=<your private key> \
    npm run buy -- espresso

Buys one item — `espresso`, `flat-white`, or `cold-brew` — from the hosted
store by default, pays the 402 challenge in HBAR, and prints what it paid,
the transaction id, and a HashScan link. Set `STORE_URL` to buy from a
locally-run store instead. No receipt is filed and nothing is anchored to
HCS — this is the buy step on its own, not the full walkthrough.
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Manual end-to-end verification**

This step needs a real Hedera testnet account (get one free at
https://portal.hedera.com) funded with testnet HBAR. Run:

```bash
HEDERA_OPERATOR_ID=0.0.<your account> \
HEDERA_OPERATOR_KEY=<your private key> \
npm run buy -- espresso
```

Expected output: four lines — `bought: espresso`, `paid: 0.15 HBAR`,
`transaction: 0.0.<...>@<seconds>.<nanos>`, and a `hashscan:` link. Open the
HashScan link and confirm it shows a real, settled transfer transaction. If
you don't have a funded testnet account handy, at minimum confirm the CLI
fails with an actionable message when `HEDERA_OPERATOR_ID` is unset, and when
pointed at an unreachable `STORE_URL`.

- [ ] **Step 7: Commit**

```bash
git add packages/buyer/src/cli.ts package.json README.md docs/superpowers/specs/2026-09-07-manual-buy-design.md
git commit -m "feat(buyer): a CLI to buy one item by hand — npm run buy"
```

## Verification (whole plan)

1. `npm test` — full suite passes (baseline 181 tests + 10 new from Tasks 1–2).
2. `npm run typecheck` — no errors.
3. Manual run of `npm run buy -- espresso` against the live hosted store with
   a real funded testnet account (Task 3, Step 6) — confirms the whole chain
   (402 challenge → sign → pay → settle → HashScan link) works against the
   real store, not just mocks.
