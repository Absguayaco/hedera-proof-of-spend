# Ordering Proof and Receipt-Decision Binding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

`decideAndBuy()` (`scripts/decide-and-buy.ts`) anchors a spend decision to HCS and only proceeds to payment once that anchor reaches consensus — but this ordering ("decision before payment") is enforced only by the agent's own code sequencing. Nothing lets a third party independently confirm, from public data alone, that the decision genuinely reached consensus strictly before the resulting payment settled — the original Build Kit spec's requirements A2/A3/A6/A7. Separately, the anchored decision and the settled purchase are today connected only by a human-readable string inside a thrown error message, never by any structured, independently-checkable field — requirements B2/B3.

Both gaps were confirmed still open by direct, live investigation of the current repo (not assumed): `submitHash()` discards the HCS topic sequence number the Hedera SDK's receipt already carries; the mirror node's real topic-messages response already includes `sequence_number` per message but the verifier's type doesn't declare it; and no code anywhere queries the mirror node's `/transactions/<id>` endpoint for a settlement's real consensus timestamp (confirmed live: this is distinct from, and ~8.68 seconds later than, the client-chosen valid-start time already stored — the same repo-documented gap this project has hit before). A genuinely nonexistent transaction and one simply not yet ingested by the mirror node both return an identical 404, live-confirmed today — any ordering check needs the same bounded-retry treatment this repo already ships in `scripts/e2e.ts` for topic messages.

**B6 (nonce-replay enforcement) was evaluated and is explicitly OUT OF SCOPE, by a human decision already made.** `decideAndBuy()`'s atomic decide-then-buy-in-one-function-call design, with a freshly generated UUID nonce on every call, means there is no "redeem this decision later" flow for anything to replay against — confirmed by exhaustive repo-wide grep (`nonce`, `replay`, `dedup`, `idempotent`, `once`) finding no code path anywhere that checks for nonce reuse, only three historical "disclosed, not built" doc notes. This plan closes B6 with one construction-proof test and a doc-comment explanation in `scripts/decide-and-buy.ts`, not replay-detection code.

**Correction found during exploration, not assumed:** `scripts/decide-and-buy.ts` currently contains **zero** mentions of "B6" (confirmed via direct grep) — the three existing "B6: disclosed, not built" notes all live in `docs/superpowers/plans/2026-09-08-decide-and-buy.md` (×2) and `docs/superpowers/plans/2026-09-09-audit-fixes.md` (×1), both historical plan records this plan is barred from touching. Task 5 therefore *adds* a new B6 doc comment to `scripts/decide-and-buy.ts` — there is nothing there yet to replace.

**Architecture:** Capture the HCS topic sequence number `submitHash()` already discards and thread it through `AnchorResult` (Task 1). Surface the mirror node's own `sequence_number` field on `verify()`'s result (Task 2). Add a new, independently retried settlement-consensus-timestamp lookup against the mirror node's `/transactions/<id>` endpoint (Task 3). Compose those two into a strict-ordering check a third party can run from public data alone (Task 4). Finally, add a small pure function that structurally binds a filed receipt to its authorizing decision's nonce/topic/sequence-number, plus the B6 construction-proof test (Task 5).

**Tech Stack:** TypeScript (no build step), Vitest, `@hiero-ledger/sdk`, plain `fetch` against the public Hedera mirror node REST API. Zero new npm dependencies anywhere, zero changes to `packages/verifier/package.json`.

**Verified directly before finalizing this plan** (not taken on the Plan agent's word alone): the SDK's `TransactionReceipt.topicSequenceNumber: Long | null` field exists exactly as described; the mirror node's live `/transactions/<dash-id>` behavior (real distinct `consensus_timestamp`, identical 404 for missing vs. not-yet-ingested) was reconfirmed live; `packages/verifier/src/index.test.ts`'s existing `page()` fixture helper already sets `sequence_number: index + 1` on every entry (confirmed directly: line 13), as does `__tests__/anchor-verifier-roundtrip.test.ts`'s fixture (confirmed directly: line 21) — so Task 2's test changes are genuinely minimal, not new fixture-authoring; and `scripts/decide-and-buy.ts` genuinely has zero existing "B6" mentions (confirmed directly via grep — zero matches).

## Global Constraints

- `.ts` extensions on this repo's own relative imports; SDK subpath imports (none new expected here) would need literal `.js` per the SDK's own package.json exports map.
- No build step; Node >= 24; Vitest; file-adjacent `*.test.ts`.
- `packages/verifier` must gain ZERO new npm dependencies — enforced by `scripts/check-verifier-independence.mjs` (checks only `packages/verifier/package.json`'s dependency blocks) — any new HTTP capability must use plain injectable `fetch`, exactly like `verify()` already does.
- `packages/anchor/src/hash.ts` and `packages/verifier/src/hash.ts` must never import each other (unrelated to this plan's changes, but must not be violated incidentally).
- DI convention: trailing optional parameter defaulting to the real implementation (`fetchImpl: typeof fetch = fetch`), matching every existing network-touching function in this repo.
- Error messages name what's wrong and the offending value (established voice throughout this repo).
- Commit message convention: `feat(<package>): <what>` for new capabilities in a package (`feat:` with no scope for top-level `scripts/` files, matching this repo's own `git log`), `fix(<package>): <what>` for behavior corrections.
- Run `npm run typecheck` and `npm test` (full suite) at the end of every task.
- Do not modify `scripts/e2e.ts` in this plan — wiring these new capabilities into its live orchestration is explicitly a LATER, separate follow-up. Reference its existing code as a pattern to match, without editing the file.
- Do not modify `docs/superpowers/plans/2026-09-08-decide-and-buy.md` or `docs/superpowers/plans/2026-09-09-audit-fixes.md` (historical plan records).
- **B6 (nonce-replay enforcement) is out of scope** — no replay-detection code. Close it with one construction-proof test plus a doc-comment note explaining why, in `scripts/decide-and-buy.ts` only.

## File Structure

- `packages/anchor/src/topic.ts` — gains `SubmitHashResult`; `submitHash()` now returns it instead of `void`.
- `packages/anchor/src/index.ts` — `AnchorResult` gains `sequenceNumber?: string`; `HcsOps.submitHash` return type updated; `anchorReceipt()` threads the value through.
- `packages/anchor/src/index.test.ts` — `fakeHcs()`'s default/overridable `submitHash` updated to the new return shape; new assertions/tests for `sequenceNumber`.
- `packages/verifier/src/index.ts` — `MirrorMessage`/`VerifyResult` gain `sequence_number`/`sequenceNumber`; new `fetchSettlementConsensusTimestamp()` (bounded-retry settlement lookup); new `verifyDecisionPrecedesSettlement()` (the ordering proof); small `mirrorBaseUrl()` extraction shared by all three.
- `packages/verifier/src/index.test.ts` — new tests for all of the above.
- `scripts/decide-and-buy.ts` — new `linkReceiptToDecision()` + `DecisionReceiptRef`; doc-comment additions for B6.
- `scripts/decide-and-buy.test.ts` — new tests for `linkReceiptToDecision()` and the B6 construction proof.

No new files. Each package/module keeps its single existing entry-point file, matching this repo's existing "small package, one `index.ts`" convention.

---

### Task 1: Anchor package — capture the HCS topic sequence number

**Files:**
- Modify: `packages/anchor/src/topic.ts`
- Modify: `packages/anchor/src/index.ts`
- Modify: `packages/anchor/src/index.test.ts`

**Interfaces:**
- Produces: `SubmitHashResult { readonly sequenceNumber: string }` (exported from `topic.ts`, re-exported from `index.ts`).
- Produces: `submitHash(client, topicId, hash): Promise<SubmitHashResult>` (was `Promise<void>`).
- Produces: `AnchorResult.sequenceNumber?: string`.
- Consumed by: Task 5's `linkReceiptToDecision()`.

- [ ] **Step 1: Update the failing test file** — replace `packages/anchor/src/index.test.ts` in full with:

```ts
import type { Client } from "@hiero-ledger/sdk";
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { anchorReceipt } from "./index.ts";
import type { SubmitHashResult } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const RECEIPT = { rail: "hedera", amount: "15000000" };

function fakeHcs(
  overrides: Partial<{
    createTopic: (client: Client) => Promise<string>;
    submitHash: (client: Client, topicId: string, hash: string) => Promise<SubmitHashResult>;
  }> = {},
) {
  return {
    createTopic: overrides.createTopic ?? (async () => "0.0.777"),
    submitHash: overrides.submitHash ?? (async () => ({ sequenceNumber: "1" })),
  };
}

describe("anchorReceipt", () => {
  it("creates a topic and submits the hash when no topicId is given", async () => {
    const submitted: Array<{ topicId: string; hash: string }> = [];
    const hcs = fakeHcs({
      submitHash: async (_client, topicId, hash) => {
        submitted.push({ topicId, hash });
        return { sequenceNumber: "1" };
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({
      ok: true,
      hash: hashReceipt(RECEIPT),
      topicId: "0.0.777",
      sequenceNumber: "1",
    });
    expect(submitted).toEqual([{ topicId: "0.0.777", hash: hashReceipt(RECEIPT) }]);
  });

  it("reports the topic sequence number the HCS submission returned, converted to a decimal string", async () => {
    const hcs = fakeHcs({ submitHash: async () => ({ sequenceNumber: "42" }) });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(result.sequenceNumber).toBe("42");
  });

  it("reuses a given topicId and never calls createTopic", async () => {
    let createCalled = false;
    const hcs = fakeHcs({
      createTopic: async () => {
        createCalled = true;
        return "0.0.999";
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY, topicId: "0.0.123" },
      hcs,
    );

    expect(result.ok).toBe(true);
    expect(result.topicId).toBe("0.0.123");
    expect(result.sequenceNumber).toBe("1");
    expect(createCalled).toBe(false);
  });

  it("never throws: a submit failure becomes {ok:false, error}, hash still reported", async () => {
    const hcs = fakeHcs({
      submitHash: async () => {
        throw new Error("mirror node unreachable");
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mirror node unreachable/);
    // An unanchored receipt is worth more than a lost one — the hash is
    // still reported even though the anchor failed.
    expect(result.hash).toBe(hashReceipt(RECEIPT));
    expect(result.sequenceNumber).toBeUndefined();
  });

  it("reports the newly created topicId when submitHash fails, so a retry can reuse it", async () => {
    const hcs = fakeHcs({
      createTopic: async () => "0.0.777",
      submitHash: async () => {
        throw new Error("mirror node unreachable");
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({
      ok: false,
      hash: hashReceipt(RECEIPT),
      topicId: "0.0.777",
      error: expect.stringMatching(/mirror node unreachable/),
    });
  });

  it("never throws: an invalid operator key becomes {ok:false, error}", async () => {
    const INVALID_KEY = "not-a-key";
    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: INVALID_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(INVALID_KEY);
    expect(result.error).not.toContain(OPERATOR_KEY);
  });

  it("never throws: an invalid operator id becomes {ok:false, error}, not a rejected promise", async () => {
    await expect(
      anchorReceipt(
        RECEIPT,
        { operatorId: "not-an-account-id", operatorKey: OPERATOR_KEY },
        fakeHcs(),
      ),
    ).resolves.toMatchObject({ ok: false, hash: hashReceipt(RECEIPT) });
  });

  it("never throws: a receipt that fails canonicalization becomes {ok:false, error}, empty hash", async () => {
    const result = await anchorReceipt(
      { n: 1 },
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.hash).toBe("");
    expect(result.error).toMatch(/not canonicalizable/);
  });
});
```

- [ ] **Step 2: Run it, confirm RED**

Run: `npx vitest run packages/anchor/src/index.test.ts`
Expected: FAIL — `SubmitHashResult` is not exported from `./index.ts`, and `result.sequenceNumber` is `undefined` against the `toEqual` assertions above.

- [ ] **Step 3: Implement — `packages/anchor/src/topic.ts` (full new file)**

```ts
/**
 * HCS topic lifecycle. One topic holds every anchor for a demo account.
 */
import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Client } from "@hiero-ledger/sdk";
import { HASH_VERSION } from "./hash.ts";

/** The message written to the topic. Only the hash leaves the system — no
 *  amounts, no merchants, no line items, and no receipt id. A verifier finds
 *  its receipt by scanning for a matching hash, which is exactly the privacy
 *  property claimed: the topic alone tells an observer nothing. */
export interface AnchorMessage {
  readonly v: number;
  readonly h: string;
}

/** What submitHash() reports back once the submission reaches consensus.
 *  Carries the HCS topic sequence number -- the position this message holds
 *  in the topic's own ordered log -- converted from the SDK's `Long` to a
 *  decimal string (this project's numbers-travel-as-strings convention;
 *  see packages/anchor/src/hash.ts's canonicalize() rule 2, which rejects
 *  raw JS numbers outright). This is what closes Build Kit B2/B3: a
 *  structured, independently-checkable reference a filed receipt can carry
 *  back to the decision that authorized it. */
export interface SubmitHashResult {
  readonly sequenceNumber: string;
}

/** The exact bytes written to the topic. Pulled out on its own so the "only
 *  {v, h} leaves the system" claim is checkable without a network. */
export function encodeAnchorMessage(hash: string): string {
  const message: AnchorMessage = { v: HASH_VERSION, h: hash };
  return JSON.stringify(message);
}

export async function createTopic(client: Client): Promise<string> {
  const response = await new TopicCreateTransaction()
    .setTopicMemo("hedera-proof-of-spend anchor")
    .execute(client);
  // execute() only reports the pre-check passed; getReceipt() is what
  // observes real consensus failure (same reasoning as @x402/hedera's
  // createHederaSignAndSubmitTransaction and this repo's other Hedera calls).
  const receipt = await response.getReceipt(client);
  if (!receipt.topicId) {
    throw new Error("TopicCreateTransaction succeeded but the receipt carried no topic id.");
  }
  return receipt.topicId.toString();
}

export async function submitHash(
  client: Client,
  topicId: string,
  hash: string,
): Promise<SubmitHashResult> {
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(encodeAnchorMessage(hash))
    .execute(client);
  // getReceipt() throws ReceiptStatusError on a non-SUCCESS status — that
  // throw is what anchorReceipt()'s catch-everything contract relies on.
  const receipt = await response.getReceipt(client);
  // topicSequenceNumber is `Long | null` on the SDK's TransactionReceipt --
  // populated specifically for TopicMessageSubmitTransaction receipts. A
  // real Long is always an object (never falsy), so this is a strict
  // null/undefined check, not a truthiness check that a real sequence
  // number of 0 could ever accidentally trip.
  if (receipt.topicSequenceNumber === null || receipt.topicSequenceNumber === undefined) {
    throw new Error(
      `TopicMessageSubmitTransaction succeeded but the receipt carried no topic sequence ` +
        `number (topic ${topicId}).`,
    );
  }
  return { sequenceNumber: receipt.topicSequenceNumber.toString() };
}
```

- [ ] **Step 4: Implement — `packages/anchor/src/index.ts` (full new file)**

```ts
/**
 * Agent-side HCS anchoring.
 *
 * This runs entirely on the agent side. The receipt ledger never touches
 * Hedera and does not know anchoring exists — which is what keeps the ledger a
 * dependency rather than something this project extends.
 *
 * Anchoring is BEST-EFFORT by design. A failed anchor must never block a
 * purchase or lose a receipt: an unanchored receipt is worth more than a lost
 * one, and it is visibly unanchored, which is the correct failure mode.
 */
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { hashReceipt } from "./hash.ts";
import { createTopic, submitHash } from "./topic.ts";
import type { SubmitHashResult } from "./topic.ts";

export interface AnchorResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly topicId?: string;
  /** The anchoring message's position in the topic's own ordered log,
   *  present only when ok is true. Together with topicId this is what
   *  closes Build Kit B2/B3 -- a structured, independently-checkable
   *  reference a filed receipt can carry back to the decision that
   *  authorized it (see scripts/decide-and-buy.ts's linkReceiptToDecision). */
  readonly sequenceNumber?: string;
  /** Present when ok is false. Reported, never thrown. */
  readonly error?: string;
}

/** The network-facing seam. Real HCS calls in production; a fake in tests —
 *  the same shape `fetchImpl` plays in packages/buyer, but for the Hedera SDK
 *  boundary instead of HTTP. Client construction and key parsing stay real in
 *  both, matching how buyer's tests exercise real offline signing. */
export interface HcsOps {
  readonly createTopic: (client: Client) => Promise<string>;
  readonly submitHash: (client: Client, topicId: string, hash: string) => Promise<SubmitHashResult>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function anchorReceipt(
  receipt: unknown,
  opts: { operatorId: string; operatorKey: string; topicId?: string },
  hcs: HcsOps = { createTopic, submitHash },
): Promise<AnchorResult> {
  let hash: string;
  try {
    hash = hashReceipt(receipt);
  } catch (error) {
    return { ok: false, hash: "", error: describeError(error) };
  }

  let operatorKey: PrivateKey;
  try {
    operatorKey = PrivateKey.fromString(opts.operatorKey);
  } catch {
    return {
      ok: false,
      hash,
      error:
        `HEDERA_OPERATOR_KEY is not a valid Hedera private key ` +
        `(${opts.operatorKey.length} characters). See .env.example. ` +
        `The key itself is not reported here on purpose.`,
    };
  }

  let client: Client | undefined;
  try {
    try {
      client = Client.forTestnet();
      client.setOperator(opts.operatorId, operatorKey);
      const topicId = opts.topicId ?? (await hcs.createTopic(client));
      try {
        const submitted = await hcs.submitHash(client, topicId, hash);
        return { ok: true, hash, topicId, sequenceNumber: submitted.sequenceNumber };
      } catch (error) {
        // A topic may already exist even though submission failed — report it
        // so a retry reuses it instead of creating (and leaking) a new one.
        return { ok: false, hash, topicId, error: describeError(error) };
      }
    } catch (error) {
      return {
        ok: false,
        hash,
        ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
        error: describeError(error),
      };
    }
  } finally {
    if (client) {
      try {
        client.close();
      } catch {
        // ignored on purpose
      }
    }
  }
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
export { createTopic, submitHash } from "./topic.ts";
export type { AnchorMessage, SubmitHashResult } from "./topic.ts";
```

- [ ] **Step 5: Run it, confirm GREEN**

Run: `npx vitest run packages/anchor/src/index.test.ts packages/anchor/src/topic.test.ts __tests__/anchor-verifier-roundtrip.test.ts`
Expected: PASS. The roundtrip test is unaffected — it exercises `encodeAnchorMessage()` + `verify()` directly, never `anchorReceipt()`/`submitHash()`.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/anchor/src/topic.ts packages/anchor/src/index.ts packages/anchor/src/index.test.ts
git commit -m "feat(anchor): capture the HCS topic sequence number on a successful anchor"
```

---

### Task 2: Verifier package — surface the mirror node's `sequence_number`

**Files:**
- Modify: `packages/verifier/src/index.ts`
- Modify: `packages/verifier/src/index.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent read-path change).
- Produces: `VerifyResult.sequenceNumber?: number`. Produces: a private `mirrorBaseUrl(network: string): string` helper, reused by Task 3.

- [ ] **Step 1: Add the failing assertion** — in `packages/verifier/src/index.test.ts`, change the first test in the `describe("verify", ...)` block:

```ts
  it("reports a match when the topic carries the receipt's hash", async () => {
    const fetchImpl = (async () => page([{ v: 1, h: HASH }])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(result.computedHash).toBe(HASH);
    expect(result.consensusTimestamp).toBe("1700000000.000000001");
    expect(result.sequenceNumber).toBe(1);
    expect(result.hashscanUrl).toBe("https://hashscan.io/testnet/topic/0.0.777/messages");
  });
```

(The `page()` helper already sets `sequence_number: index + 1` for every fixture entry — confirmed directly at line 13 of the current file — this is the sole line that needs changing in that test.)

- [ ] **Step 2: Run it, confirm RED**

Run: `npx vitest run packages/verifier/src/index.test.ts`
Expected: FAIL — `result.sequenceNumber` is `undefined`.

- [ ] **Step 3: Implement — `packages/verifier/src/index.ts` (full new file)**

```ts
import { hashReceipt } from "./hash.ts";

/**
 * An independent verifier.
 *
 * Takes a receipt, hashes it, queries the HCS topic, and reports one of three
 * outcomes. It depends on nothing of ours: one public Hedera SDK and node's
 * standard library. See this package's package.json — that dependency list is
 * the claim, and a workspace dependency added there would quietly void it.
 *
 * What each outcome means:
 *   match   — this is exactly what was recorded, at the time claimed
 *   missing — never anchored; may have been added to the ledger afterwards
 *   altered — a hash was anchored for this receipt id, but the receipt differs,
 *             so the record changed after the fact
 *
 * What this does NOT prove: that the receipt is true. A ledger that files a
 * wrong receipt and anchors it has anchored a wrong receipt, immutably. This
 * is tamper-evidence, not correctness.
 */
export type Outcome = "match" | "missing" | "altered";

export interface VerifyResult {
  readonly outcome: Outcome;
  /** The hash this verifier computed, independently, from the receipt. */
  readonly computedHash: string;
  /** Consensus timestamp of the anchoring message, when one was found. */
  readonly consensusTimestamp?: string;
  /** The anchoring message's position in the topic's own ordered log, read
   *  straight from the mirror node. Present only on a "match". */
  readonly sequenceNumber?: number;
  /** Link to the same message on HashScan, on a network neither party controls. */
  readonly hashscanUrl?: string;
}

/** Confirmed live (2026-09-08): the mirror node's public REST base URLs. Not
 *  imported from @x402/hedera on purpose — see this package's package.json:
 *  the dependency list is the claim. */
const MIRROR_NODE_URL: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

/** Validates `network` and returns its mirror-node base URL. Shared by every
 *  function in this file that reads from the mirror node -- verify() and
 *  fetchSettlementConsensusTimestamp(). Object.hasOwn guards against
 *  inherited Object.prototype members ("toString", "constructor",
 *  "valueOf", ...) being read back as a truthy "known network" when
 *  network comes straight from --network / env. */
function mirrorBaseUrl(network: string): string {
  if (!Object.hasOwn(MIRROR_NODE_URL, network)) {
    throw new Error(`Unsupported network "${network}". Expected "testnet" or "mainnet".`);
  }
  return MIRROR_NODE_URL[network];
}

interface MirrorMessage {
  readonly message: string; // base64
  readonly consensus_timestamp: string;
  /** The message's position in the topic's own ordered log. Confirmed live
   *  against the real mirror node that this field is present on every entry
   *  as a plain JSON number -- unlike the SDK-side
   *  TransactionReceipt.topicSequenceNumber, which is a `Long`. */
  readonly sequence_number: number;
}

interface MirrorMessagesPage {
  readonly messages: readonly MirrorMessage[];
  readonly links: { readonly next: string | null };
}

export async function verify(
  receipt: unknown,
  opts: { topicId: string; network?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const computedHash = hashReceipt(receipt);
  const network = opts.network ?? "testnet";
  const base = mirrorBaseUrl(network);

  let path: string | null = `/api/v1/topics/${opts.topicId}/messages?limit=100`;
  while (path) {
    const response = await fetchImpl(`${base}${path}`);
    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for topic ${opts.topicId}. ` +
          `Check the topic id and network.`,
      );
    }
    const parsedPage = (await response.json()) as Partial<MirrorMessagesPage>;
    if (!Array.isArray(parsedPage?.messages)) {
      throw new Error(
        `Mirror node returned 200 but not a topic-messages page for topic ` +
          `${opts.topicId} on ${network}. Got: ${JSON.stringify(parsedPage).slice(0, 200)}`,
      );
    }

    for (const entry of parsedPage.messages) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(entry.message, "base64").toString("utf8"));
        if (
          decoded !== null &&
          typeof decoded === "object" &&
          (decoded as { h?: unknown }).h === computedHash
        ) {
          return {
            outcome: "match",
            computedHash,
            consensusTimestamp: entry.consensus_timestamp,
            sequenceNumber: entry.sequence_number,
            hashscanUrl: `https://hashscan.io/${network}/topic/${opts.topicId}/messages`,
          };
        }
      } catch {
        // not our JSON shape — skip rather than fail the whole scan
      }
    }

    // links.next is a relative path, not an absolute URL — confirmed live.
    path = parsedPage.links?.next ?? null;
  }

  return { outcome: "missing", computedHash };
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
```

(Tasks 3 and 4 append to this same file below the `verify()` function; the full final file is shown at the end of Task 4.)

- [ ] **Step 4: Run it, confirm GREEN**

Run: `npx vitest run packages/verifier/src/index.test.ts __tests__/anchor-verifier-roundtrip.test.ts`
Expected: PASS. (The roundtrip test's fixture already includes `sequence_number: 1` — confirmed directly at line 21 of the current file — so it needs no changes and stays green.)

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/verifier/src/index.ts packages/verifier/src/index.test.ts
git commit -m "feat(verifier): surface the mirror node's sequence_number on a match"
```

---

### Task 3: Verifier package — settlement consensus-timestamp lookup with bounded retry

**Files:**
- Modify: `packages/verifier/src/index.ts`
- Modify: `packages/verifier/src/index.test.ts`

**Interfaces:**
- Consumes: `mirrorBaseUrl()` (Task 2, private, same file).
- Produces: `SettlementConsensusResult { readonly found: boolean; readonly transactionId: string; readonly consensusTimestamp?: string; readonly result?: string }`.
- Produces: `fetchSettlementConsensusTimestamp(transactionId, opts?, fetchImpl?, sleepImpl?): Promise<SettlementConsensusResult>`.
- Consumed by: Task 4's `verifyDecisionPrecedesSettlement()`.

- [ ] **Step 1: Write the failing tests** — append to `packages/verifier/src/index.test.ts`, inside the existing top-level import block add:

```ts
import { fetchSettlementConsensusTimestamp, verify } from "./index.ts";
```

(replacing the existing `import { verify } from "./index.ts";` line), then append this new `describe` block at the end of the file, after the closing `});` of `describe("verify", ...)`:

```ts
function transactionsPage(entries: Array<{ consensus_timestamp: string; result?: string }>): Response {
  const body = {
    transactions: entries.map((entry) => ({
      consensus_timestamp: entry.consensus_timestamp,
      result: entry.result ?? "SUCCESS",
    })),
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function notFound(): Response {
  return new Response(JSON.stringify({ _status: { messages: [{ message: "Not found" }] } }), {
    status: 404,
  });
}

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

describe("fetchSettlementConsensusTimestamp", () => {
  const TRANSACTION_ID = "0.0.7162784@1788825896.303987758";

  it("converts the @/dot transaction id to the mirror node's dash form and queries it", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return transactionsPage([{ consensus_timestamp: "1788825904.988176169" }]);
    }) as typeof fetch;

    await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(requested).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788825896-303987758",
    ]);
  });

  it("reports the real consensus timestamp on a first-attempt hit", async () => {
    const fetchImpl = (async () =>
      transactionsPage([{ consensus_timestamp: "1788825904.988176169" }])) as typeof fetch;

    const result = await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(result).toEqual({
      found: true,
      transactionId: TRANSACTION_ID,
      consensusTimestamp: "1788825904.988176169",
      result: "SUCCESS",
    });
  });

  it("retries on 404 (mirror-node ingestion lag), succeeding once the transaction appears", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 3 ? notFound() : transactionsPage([{ consensus_timestamp: "1788825904.988176169" }]);
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    const result = await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      {},
      fetchImpl,
      fakeSleep(sleepCalls),
    );

    expect(result.found).toBe(true);
    expect(call).toBe(3);
    expect(sleepCalls).toEqual([5_000, 5_000]);
  });

  it("treats a 200 response with an empty transactions array as not-yet-ingested and retries", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 2 ? transactionsPage([]) : transactionsPage([{ consensus_timestamp: "9.9" }]);
    }) as typeof fetch;

    const result = await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(result.found).toBe(true);
    expect(call).toBe(2);
  });

  it("reports not-found only after the retry budget (6 attempts) is exhausted", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return notFound();
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    const result = await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      {},
      fetchImpl,
      fakeSleep(sleepCalls),
    );

    expect(result).toEqual({ found: false, transactionId: TRANSACTION_ID });
    expect(call).toBe(6);
    expect(sleepCalls).toHaveLength(5);
  });

  it("throws on a non-404 error status rather than silently reporting not-found", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/500/);
  });

  it("throws a message naming the transaction id when a 200 response isn't a transactions page", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 200 })) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(TRANSACTION_ID);
  });

  it("rejects a transaction id that isn't payer@seconds.nanos before ever calling fetch", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return transactionsPage([]);
    }) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp("not-a-transaction-id", {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/Not a Hedera transaction id/);
    expect(fetchCalled).toBe(false);
  });

  it("queries the testnet mirror node by default and mainnet when asked", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return transactionsPage([{ consensus_timestamp: "1.1" }]);
    }) as typeof fetch;

    await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      { network: "mainnet" },
      fetchImpl,
      fakeSleep([]),
    );

    expect(requested[0]).toBe(
      "https://mainnet-public.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788825896-303987758",
    );
  });

  it('rejects a "network" value inherited from Object.prototype instead of bypassing the guard', async () => {
    const fetchImpl = (async () => transactionsPage([])) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(
        TRANSACTION_ID,
        { network: "toString" },
        fetchImpl,
        fakeSleep([]),
      ),
    ).rejects.toThrow(/Unsupported network "toString"/);
  });
});
```

- [ ] **Step 2: Run it, confirm RED**

Run: `npx vitest run packages/verifier/src/index.test.ts`
Expected: FAIL — `fetchSettlementConsensusTimestamp` is not exported.

- [ ] **Step 3: Implement** — append to `packages/verifier/src/index.ts`, immediately after the `export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";` line:

```ts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SETTLEMENT_MAX_ATTEMPTS = 6;
const SETTLEMENT_RETRY_DELAY_MS = 5_000;

// Same shape as packages/buyer/src/settlement.ts's TX_ID -- deliberately
// duplicated rather than imported: packages/verifier must depend on nothing
// of ours (see this package's package.json and scripts/check-verifier-independence.mjs),
// and importing @proof-of-spend/buyer here would be exactly the kind of
// workspace dependency that guard exists to catch.
const SETTLEMENT_TRANSACTION_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

/**
 * The mirror node's /transactions endpoint requires the DASH form
 * (shard.realm.num-seconds-nanos), confirmed live -- the @/dot form this
 * repo's own HederaSettlement.transactionId uses (payer@seconds.nanos) is
 * rejected with HTTP 400. Built from the parsed match groups, never by
 * string-replacing the dot/@ form (which would also mangle the dots inside
 * the fee-payer's own shard.realm.num account id) -- same reasoning as
 * packages/buyer/src/settlement.ts's hashscanUrl().
 */
function toDashTransactionId(raw: string): string {
  const match = SETTLEMENT_TRANSACTION_ID.exec(raw);
  if (!match) {
    throw new Error(
      `Not a Hedera transaction id (got "${raw}"). Expected payer@seconds.nanos, ` +
        `e.g. 0.0.12345@1699999999.123456789 -- the same shape ` +
        `packages/buyer/src/settlement.ts's HederaSettlement.transactionId produces.`,
    );
  }
  const [, feePayer, seconds, nanos] = match;
  return `${feePayer}-${seconds}-${nanos}`;
}

interface MirrorTransaction {
  readonly consensus_timestamp: string;
  readonly result: string;
}

interface MirrorTransactionsPage {
  readonly transactions: readonly MirrorTransaction[];
}

export interface SettlementConsensusResult {
  readonly found: boolean;
  readonly transactionId: string;
  readonly consensusTimestamp?: string;
  readonly result?: string;
}

/**
 * Looks up a settled Hedera payment's REAL consensus timestamp from the
 * public mirror node -- distinct from, and often several seconds later
 * than, the transaction's own valid-start time (HederaSettlement.validStartSeconds/
 * Nanos, chosen by the paying client, not the network).
 *
 * A genuinely nonexistent transaction and one that simply hasn't been
 * ingested by the mirror node yet both return HTTP 404 -- indistinguishable
 * from a single lookup, and the ingestion lag is the same order of magnitude
 * as this repo's own already-measured HCS-to-mirror-node lag (~8.68s on a
 * real transaction). So a 404 is retried (same 6-attempts/5s-apart shape as
 * scripts/e2e.ts's existing topic-message retry loop) before being treated
 * as "does not exist".
 */
export async function fetchSettlementConsensusTimestamp(
  transactionId: string,
  opts: { network?: string } = {},
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<SettlementConsensusResult> {
  const network = opts.network ?? "testnet";
  const base = mirrorBaseUrl(network);
  const dashId = toDashTransactionId(transactionId);
  const url = `${base}/api/v1/transactions/${dashId}`;

  for (let attempt = 1; attempt <= SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(url);

    if (response.status === 404) {
      if (attempt < SETTLEMENT_MAX_ATTEMPTS) {
        await sleepImpl(SETTLEMENT_RETRY_DELAY_MS);
        continue;
      }
      return { found: false, transactionId };
    }

    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for transaction ${transactionId} ` +
          `(${dashId}). Check the transaction id and network.`,
      );
    }

    const parsed = (await response.json()) as Partial<MirrorTransactionsPage>;
    if (!Array.isArray(parsed?.transactions)) {
      throw new Error(
        `Mirror node returned 200 but not a transactions page for ${transactionId} ` +
          `(${dashId}) on ${network}. Got: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }

    const [first] = parsed.transactions;
    if (!first) {
      if (attempt < SETTLEMENT_MAX_ATTEMPTS) {
        await sleepImpl(SETTLEMENT_RETRY_DELAY_MS);
        continue;
      }
      return { found: false, transactionId };
    }

    return {
      found: true,
      transactionId,
      consensusTimestamp: first.consensus_timestamp,
      result: first.result,
    };
  }

  // Unreachable: the loop above always returns before exhausting its own
  // bound. Present only so TypeScript sees every path returning.
  return { found: false, transactionId };
}
```

- [ ] **Step 4: Run it, confirm GREEN**

Run: `npx vitest run packages/verifier/src/index.test.ts`
Expected: PASS, in well under a second — every test injects a fake `sleepImpl`, so no real 30-second retry budget is ever spent.

- [ ] **Step 5: Verify independence is preserved**

Run: `node scripts/check-verifier-independence.mjs`
Expected: `ok: verifier depends only on @hiero-ledger/sdk` (no `package.json` changes were made, so this is a sanity check, not a functional change).

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/verifier/src/index.ts packages/verifier/src/index.test.ts
git commit -m "feat(verifier): add a bounded-retry settlement consensus-timestamp lookup"
```

---

### Task 4: Verifier package — the A2/A3/A6/A7 ordering proof

**Files:**
- Modify: `packages/verifier/src/index.ts`
- Modify: `packages/verifier/src/index.test.ts`

**Interfaces:**
- Consumes: `VerifyResult` (Task 2), `fetchSettlementConsensusTimestamp()`/`SettlementConsensusResult` (Task 3).
- Produces: `OrderingOutcome`, `OrderingProofResult`, `verifyDecisionPrecedesSettlement(decisionVerify, settlementTransactionId, opts?, fetchImpl?, sleepImpl?): Promise<OrderingProofResult>`.

**Design note (why compose rather than fuse):** this function takes an already-computed `VerifyResult` rather than re-running a topic scan itself. The caller (e.g. a future `scripts/e2e.ts` wiring, out of scope here) is expected to have already run `verify()` with its own bounded retry against topic-ingestion lag — exactly the pattern already shipped in `scripts/e2e.ts`. Fusing that scan into this function would either duplicate that retry loop or silently drop it, and would compound two independent ~30-second retry budgets into one opaque ~60-second call. Composing two already-tested, independently retried primitives keeps each one's retry budget separate, each one unit-testable alone, and matches this repo's existing preference for small composed steps over one large orchestrating call (see `scripts/e2e.ts`'s own steps 4/5/6, each a separate call the script composes, not one fused function).

- [ ] **Step 1: Write the failing tests** — in `packages/verifier/src/index.test.ts`, update the import line once more:

```ts
import { fetchSettlementConsensusTimestamp, verify, verifyDecisionPrecedesSettlement } from "./index.ts";
import type { VerifyResult } from "./index.ts";
```

then append this final `describe` block at the end of the file:

```ts
describe("verifyDecisionPrecedesSettlement", () => {
  const SETTLEMENT_TX_ID = "0.0.7162784@1788825896.303987758";

  function matchResult(consensusTimestamp: string): VerifyResult {
    return {
      outcome: "match",
      computedHash: "a".repeat(64),
      consensusTimestamp,
      sequenceNumber: 1,
      hashscanUrl: "https://hashscan.io/testnet/topic/0.0.777/messages",
    };
  }

  it("reports decision_before_settlement when the decision's consensus timestamp genuinely precedes the settlement's", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          transactions: [{ consensus_timestamp: "1788825904.988176169", result: "SUCCESS" }],
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await verifyDecisionPrecedesSettlement(
      matchResult("1788825896.100000000"),
      SETTLEMENT_TX_ID,
      {},
      fetchImpl,
      async () => {},
    );

    expect(result).toEqual({
      outcome: "decision_before_settlement",
      settlementTransactionId: SETTLEMENT_TX_ID,
      decisionConsensusTimestamp: "1788825896.100000000",
      settlementConsensusTimestamp: "1788825904.988176169",
    });
  });

  it("reports decision_not_before_settlement when the decision's timestamp is not strictly earlier", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          transactions: [{ consensus_timestamp: "1788825896.100000000", result: "SUCCESS" }],
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await verifyDecisionPrecedesSettlement(
      matchResult("1788825904.988176169"), // AFTER the settlement's consensus timestamp
      SETTLEMENT_TX_ID,
      {},
      fetchImpl,
      async () => {},
    );

    expect(result.outcome).toBe("decision_not_before_settlement");
  });

  it("reports decision_not_before_settlement for equal timestamps -- strictly before, not before-or-equal", async () => {
    const SAME = "1788825900.000000000";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ transactions: [{ consensus_timestamp: SAME, result: "SUCCESS" }] }), {
        status: 200,
      })) as typeof fetch;

    const result = await verifyDecisionPrecedesSettlement(
      matchResult(SAME),
      SETTLEMENT_TX_ID,
      {},
      fetchImpl,
      async () => {},
    );

    expect(result.outcome).toBe("decision_not_before_settlement");
  });

  it("reports decision_not_anchored without ever calling fetch, when the decision's verify() outcome wasn't a match", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await verifyDecisionPrecedesSettlement(
      { outcome: "missing", computedHash: "a".repeat(64) },
      SETTLEMENT_TX_ID,
      {},
      fetchImpl,
      async () => {},
    );

    expect(result).toEqual({
      outcome: "decision_not_anchored",
      settlementTransactionId: SETTLEMENT_TX_ID,
    });
    expect(fetchCalled).toBe(false);
  });

  it("reports settlement_not_found once the settlement lookup's own retry budget is exhausted", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ _status: { messages: [{ message: "Not found" }] } }), {
        status: 404,
      })) as typeof fetch;
    const sleepCalls: number[] = [];

    const result = await verifyDecisionPrecedesSettlement(
      matchResult("1788825896.100000000"),
      SETTLEMENT_TX_ID,
      {},
      fetchImpl,
      async (ms: number) => {
        sleepCalls.push(ms);
      },
    );

    expect(result).toEqual({
      outcome: "settlement_not_found",
      settlementTransactionId: SETTLEMENT_TX_ID,
      decisionConsensusTimestamp: "1788825896.100000000",
    });
    expect(sleepCalls).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run it, confirm RED**

Run: `npx vitest run packages/verifier/src/index.test.ts`
Expected: FAIL — `verifyDecisionPrecedesSettlement` is not exported.

- [ ] **Step 3: Implement** — append to `packages/verifier/src/index.ts`, at the very end of the file:

```ts

export type OrderingOutcome =
  | "decision_before_settlement"
  | "decision_not_before_settlement"
  | "decision_not_anchored"
  | "settlement_not_found";

export interface OrderingProofResult {
  readonly outcome: OrderingOutcome;
  readonly settlementTransactionId: string;
  readonly decisionConsensusTimestamp?: string;
  readonly settlementConsensusTimestamp?: string;
}

const CONSENSUS_TIMESTAMP = /^(\d+)\.(\d+)$/;

/** Converts a mirror-node "seconds.nanoseconds" consensus timestamp into a
 *  single BigInt of nanoseconds, so two timestamps can be compared exactly.
 *  Lexicographic string comparison is NOT safe here: nothing guarantees the
 *  two timestamps being compared have the same digit count, and the seconds
 *  component will eventually grow an extra digit (Hedera's mainnet launched
 *  in 2019 with 10-digit Unix seconds; that stays 10 digits until the year
 *  2286, but is not a safe assumption to bake in silently). */
function timestampToNanos(timestamp: string): bigint {
  const match = CONSENSUS_TIMESTAMP.exec(timestamp);
  if (!match) {
    throw new Error(
      `Not a mirror-node consensus timestamp (got "${timestamp}"). Expected "seconds.nanoseconds".`,
    );
  }
  const [, seconds, nanos] = match;
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0").slice(0, 9));
}

/**
 * The A2/A3/A6/A7 ordering proof: given the decision anchor's own VerifyResult
 * (from verify(), already reconciled against the mirror node) and the Hedera
 * transaction id the payment settled under, reports whether the decision's
 * anchor genuinely reached HCS consensus strictly before the payment
 * settled -- checkable by a third party from public data alone, with no
 * trust in the agent's own code sequencing required. This is what
 * scripts/decide-and-buy.ts's "decision anchored before payment" ordering
 * was, until now, enforced only by its own code sequencing to guarantee --
 * this function is the independent, public check for it.
 */
export async function verifyDecisionPrecedesSettlement(
  decisionVerify: VerifyResult,
  settlementTransactionId: string,
  opts: { network?: string } = {},
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<OrderingProofResult> {
  if (decisionVerify.outcome !== "match" || decisionVerify.consensusTimestamp === undefined) {
    return { outcome: "decision_not_anchored", settlementTransactionId };
  }

  const settlement = await fetchSettlementConsensusTimestamp(
    settlementTransactionId,
    opts,
    fetchImpl,
    sleepImpl,
  );

  if (!settlement.found || settlement.consensusTimestamp === undefined) {
    return {
      outcome: "settlement_not_found",
      settlementTransactionId,
      decisionConsensusTimestamp: decisionVerify.consensusTimestamp,
    };
  }

  const decisionNanos = timestampToNanos(decisionVerify.consensusTimestamp);
  const settlementNanos = timestampToNanos(settlement.consensusTimestamp);

  return {
    outcome:
      decisionNanos < settlementNanos
        ? "decision_before_settlement"
        : "decision_not_before_settlement",
    settlementTransactionId,
    decisionConsensusTimestamp: decisionVerify.consensusTimestamp,
    settlementConsensusTimestamp: settlement.consensusTimestamp,
  };
}
```

- [ ] **Step 4: Run it, confirm GREEN**

Run: `npx vitest run packages/verifier/src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/verifier/src/index.ts packages/verifier/src/index.test.ts
git commit -m "feat(verifier): add an independently-checkable decision-before-settlement ordering proof"
```

At this point `packages/verifier/src/index.ts` exports, in full: `Outcome`, `VerifyResult`, `verify()`, `SettlementConsensusResult`, `fetchSettlementConsensusTimestamp()`, `OrderingOutcome`, `OrderingProofResult`, `verifyDecisionPrecedesSettlement()`, plus the re-exported `hashReceipt`, `canonicalize`, `HASH_VERSION`.

---

### Task 5: `scripts/decide-and-buy.ts` — receipt-decision binding (B2/B3) and B6 closure

**Files:**
- Modify: `scripts/decide-and-buy.ts`
- Modify: `scripts/decide-and-buy.test.ts`

**Interfaces:**
- Consumes: `AnchorResult.sequenceNumber` (Task 1).
- Produces: `DecisionReceiptRef { nonce, topicId, sequenceNumber }`, `linkReceiptToDecision(receipt, ref): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests** — in `scripts/decide-and-buy.test.ts`, update the top imports:

```ts
import { describe, expect, it } from "vitest";
import type { AnchorResult } from "@proof-of-spend/anchor";
import { canonicalize } from "@proof-of-spend/anchor";
import type { BuyResult } from "@proof-of-spend/buyer";
import type { CheckBudget, Decision } from "./decide-and-buy.ts";
import { decideAndBuy, linkReceiptToDecision } from "./decide-and-buy.ts";
```

then append these two `describe` blocks at the end of the file:

```ts
describe("linkReceiptToDecision", () => {
  it("adds a structured decision reference to the receipt -- B2/B3: no longer only a string in an error message", () => {
    const receipt = { rail: "hedera", amountTinybar: "15000000" };

    const linked = linkReceiptToDecision(receipt, {
      nonce: "11111111-1111-1111-1111-111111111111",
      topicId: "0.0.777",
      sequenceNumber: "42",
    });

    expect(linked).toEqual({
      rail: "hedera",
      amountTinybar: "15000000",
      decision: {
        nonce: "11111111-1111-1111-1111-111111111111",
        topicId: "0.0.777",
        sequenceNumber: "42",
      },
    });
    // Every value canonicalize() will see must be a string -- confirms the
    // linked receipt is still hashable under the hash-spec rule that
    // rejects raw JS numbers (packages/anchor/src/hash.ts, rule 2).
    expect(() => canonicalize(linked)).not.toThrow();
  });

  it("does not mutate the original receipt object", () => {
    const receipt = { rail: "hedera" };

    linkReceiptToDecision(receipt, { nonce: "n", topicId: "0.0.1", sequenceNumber: "1" });

    expect(receipt).toEqual({ rail: "hedera" });
  });
});

describe("decideAndBuy — B6 (nonce-replay enforcement, evaluated and closed by construction)", () => {
  it("two calls for the identical request -- even concurrent -- are each independently anchored and each independently attempt a purchase, proving there is no separate 'redeem this decision later' step for a replay to target", async () => {
    const anchorCalls: unknown[] = [];
    const anchorImpl = (async (decision: unknown) => {
      anchorCalls.push(decision);
      return {
        ok: true,
        hash: "a".repeat(64),
        topicId: "0.0.777",
        sequenceNumber: String(anchorCalls.length),
      } satisfies AnchorResult;
    }) as Parameters<typeof decideAndBuy>[2];

    const buyCalls: unknown[] = [];
    const buyImpl = (async (request: unknown) => {
      buyCalls.push(request);
      return PURCHASE;
    }) as Parameters<typeof decideAndBuy>[3];

    // Same REQUEST object, called twice concurrently. If decideAndBuy() held
    // any shared mutable state keyed by nonce, agent, or resource (a cache,
    // a "decision already anchored" map -- anything a replay-check would
    // need in order to exist), this would surface it: either a duplicate-
    // suppression effect (one call short-circuiting instead of anchoring) or
    // an observable race on shared state. Neither happens, because each
    // call generates its own randomUUID() nonce and performs its own
    // anchor-then-buy entirely inside one function invocation -- there is no
    // persisted "decision" a second, later call could redeem.
    const [first, second] = await Promise.all([
      decideAndBuy(REQUEST, approve(), anchorImpl, buyImpl),
      decideAndBuy(REQUEST, approve(), anchorImpl, buyImpl),
    ]);

    expect(first.decision.nonce).not.toBe(second.decision.nonce);
    expect(first.outcome).toBe("purchased");
    expect(second.outcome).toBe("purchased");
    // Two genuinely separate anchor calls, not one memoized/shared result
    // reused for both.
    expect(anchorCalls).toHaveLength(2);
    expect((anchorCalls[0] as Decision).nonce).not.toBe((anchorCalls[1] as Decision).nonce);
    // Two genuinely separate purchase attempts, not a second call
    // short-circuited by a "this decision was already redeemed" check --
    // exactly the persisted state B6 was evaluated to not need.
    expect(buyCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it, confirm RED**

Run: `npx vitest run scripts/decide-and-buy.test.ts`
Expected: FAIL — `linkReceiptToDecision` is not exported from `./decide-and-buy.ts`.

- [ ] **Step 3: Implement** — replace `scripts/decide-and-buy.ts` in full with:

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
    const purchase = await buyResourceImpl({
      url: request.resource,
      operatorId: request.operatorId,
      operatorKey: request.operatorKey,
    });
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
 * the primitive that follow-up will call, with
 * `{ nonce: decision.nonce, topicId: anchor.topicId, sequenceNumber: anchor.sequenceNumber }`
 * once outcome === "purchased" has confirmed those fields are present.
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
```

- [ ] **Step 4: Run it, confirm GREEN**

Run: `npx vitest run scripts/decide-and-buy.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Confirm no out-of-scope files changed**

Run: `git status --short`
Expected: only the files listed in this task's **Files** section (plus Tasks 1-4's) are modified. In particular, `scripts/e2e.ts`, `docs/superpowers/plans/2026-09-08-decide-and-buy.md`, and `docs/superpowers/plans/2026-09-09-audit-fixes.md` must show no changes.

- [ ] **Step 7: Commit**

```bash
git add scripts/decide-and-buy.ts scripts/decide-and-buy.test.ts
git commit -m "feat: bind filed receipts to their authorizing decision, and close B6 by construction"
```

---

## Verification

Run, in order, from the repo root:

1. `npm run typecheck` — must pass with no errors.
2. `npm test` — must pass in full, including: `packages/anchor/src/index.test.ts`, `packages/anchor/src/topic.test.ts`, `packages/verifier/src/index.test.ts`, `scripts/decide-and-buy.test.ts`, and `__tests__/anchor-verifier-roundtrip.test.ts` (must remain green unmodified).
3. `node scripts/check-verifier-independence.mjs` — must print `ok: verifier depends only on @hiero-ledger/sdk`, confirming zero new dependencies were introduced.
4. `git diff --stat` against the branch point — confirm `scripts/e2e.ts` and the two named historical plan docs show **zero** changes.
5. Manually re-read `scripts/decide-and-buy.ts`'s top doc comment and confirm it now states the B6 evaluation explicitly (not merely "disclosed, not built").

## What this plan does NOT do

- **No `scripts/e2e.ts` wiring.** `verifyDecisionPrecedesSettlement()` and `linkReceiptToDecision()` are built as new, independently-testable primitives in `packages/verifier` and `scripts/decide-and-buy.ts`. Calling them from the live walkthrough (`scripts/e2e.ts`'s steps 3-6) — e.g. passing `approvalResult.decision`/`approvalResult.anchor` into `linkReceiptToDecision()` before `anchorReceipt()`, or calling `verifyDecisionPrecedesSettlement(decisionVerifyResult, purchase.settlement.transactionId)` after step 5 — is a later, separate follow-up, per the Global Constraints.
- **No B6 replay-detection code.** No nonce registry, no "has this nonce been seen before" check against the topic or any other store. B6 is closed with one construction-proof test (Task 5) plus a doc-comment explanation, per the human decision already made.
- **No changes to `docs/superpowers/plans/2026-09-08-decide-and-buy.md` or `docs/superpowers/plans/2026-09-09-audit-fixes.md`.** Their existing "B6: disclosed, not built" language stands as a historical record of a past plan; only `scripts/decide-and-buy.ts`'s own doc comments are updated (and, per the live grep in this plan's Context, that file had no prior B6 note to replace — the note is newly added there).
- **No new npm dependencies anywhere in `packages/verifier`.** Every new capability (`fetchSettlementConsensusTimestamp`, `verifyDecisionPrecedesSettlement`) uses the same plain, injectable `fetch` `verify()` already uses, against the same mirror-node hosts already in `MIRROR_NODE_URL`. `scripts/check-verifier-independence.mjs` is re-run in Task 3's Step 5 and in the final Verification section to confirm this.
- **No dedicated unit tests for `topic.ts`'s real `submitHash()`/`createTopic()` against the actual Hedera SDK.** Consistent with this repo's existing pattern (confirmed by reading `packages/anchor/src/topic.test.ts`, which tests only the pure `encodeAnchorMessage()`), the SDK-facing functions are exercised only through `anchorReceipt()`'s `HcsOps` fakes, never by constructing a fake SDK `TransactionReceipt` object.

### Critical Files for Implementation
- `packages/anchor/src/topic.ts`
- `packages/anchor/src/index.ts`
- `packages/verifier/src/index.ts`
- `scripts/decide-and-buy.ts`
- `__tests__/anchor-verifier-roundtrip.test.ts` (reference, unmodified)
