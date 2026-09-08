# Anchoring & Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement HCS anchoring (`packages/anchor`) and independent verification (`packages/verifier`, including its CLI) — README's walkthrough steps 4–6.

**Architecture:** `packages/anchor/src/topic.ts` gets thin, literal wrappers around three Hedera SDK calls (`TopicCreateTransaction`, `TopicMessageSubmitTransaction`, both followed by `.getReceipt(client)` to observe real consensus failure). `packages/anchor/src/index.ts`'s `anchorReceipt()` orchestrates hash → topic → submit, catching everything (best-effort by design), with the network-facing HCS calls injected via a trailing optional parameter defaulting to the real implementations — the same DI shape as `packages/buyer`'s `fetchImpl: typeof fetch = fetch`, but for the Hedera SDK boundary. `packages/verifier/src/index.ts`'s `verify()` hashes with the verifier's own independent `hash.ts`, then walks the public mirror node's paginated topic-messages endpoint via an injected `fetchImpl`, exactly like buyer's tests. `packages/verifier/src/cli.ts` wires it to `npm run verify`.

**Tech Stack:** TypeScript (Node ≥ 24, no build step), `@hiero-ledger/sdk@2.87.0` directly (neither package depends on `@x402/hedera`), Vitest.

## Context

`hedera-proof-of-spend` demonstrates an AI agent buying from an x402-gated Hedera testnet store, then anchoring a hash of the purchase receipt to Hedera Consensus Service (HCS) so anyone — "on a network neither of us controls" — can independently confirm the ledger never quietly changed its mind. The prior slice of work ("manual buy," `packages/buyer`) is merged (PR #3); this plan is the next slice: anchoring and verification. Explicitly out of scope, left for later: budget check (step 1), filing a receipt to askReceipts (step 3), the cross-rail spend total (step 7), and `scripts/e2e.ts`'s full orchestration — all three have their own askReceipts/MCP dependency this slice doesn't need. `anchorReceipt`/`verify` both take `receipt: unknown` and operate on any JSON-object-shaped value already in hand; they never talk to askReceipts.

Both packages' hash implementations are already done and cross-checked (`packages/anchor/src/hash.ts`, `packages/verifier/src/hash.ts`, agreement tested in `__tests__/hash-agreement.test.ts`) — this plan does not touch them. What's stubbed (`throw new Error("not implemented")`, confirmed by reading each file directly): `packages/anchor/src/topic.ts` (`createTopic`, `submitHash`), `packages/anchor/src/index.ts` (`anchorReceipt`), `packages/verifier/src/index.ts` (`verify`), `packages/verifier/src/cli.ts` (`main`).

**One design decision, resolved with the human partner before this plan:** `AnchorMessage` carries only `{v, h}` — no receipt id or other correlator (a deliberate privacy choice: "the topic alone tells an observer nothing"). So `verify()`'s `Outcome` type keeps its three values (`match`/`missing`/`altered`) and doc comment as already written, but **`"altered"` is not reachable in practice** — an altered receipt hashes to something that was never published, indistinguishable from never having been anchored. Every non-match reports `"missing"`, with an inline comment at the point of decision explaining why, rather than adding a receipt-id correlator (which would break the "only hashes are published" privacy claim).

**Two claims verified live before writing this plan** (not guessed):
- Mirror node topic-messages shape, confirmed against a real active testnet topic (`0.0.7399331`): `GET https://testnet.mirrornode.hedera.com/api/v1/topics/{topicId}/messages` returns `{"messages":[{"message":"<base64>","consensus_timestamp":"...","sequence_number":N,...}],"links":{"next":"<relative path or null>"}}`. `links.next` is a **relative path**, must be prefixed with the mirror-node base URL to re-fetch.
- HashScan has **no per-message deep link**: `https://hashscan.io/testnet/topic/{id}/messages` is real (a paginated table); `https://hashscan.io/testnet/topic/{id}/message/{seq}` renders "Page Not Found." So `VerifyResult.hashscanUrl` can only point at the topic's messages tab, not the one matching message — coarser than `packages/buyer`'s transaction-scoped `hashscanUrl`, and that's the best available link.

## Global Constraints

- Testnet only; `verify()` defaults `network` to `"testnet"` when omitted, matching `.env.example`'s `HEDERA_NETWORK` convention.
- `packages/verifier` gains **zero** new dependencies — CI-enforced by `scripts/check-verifier-independence.mjs` (reads `packages/verifier/package.json`'s dependency blocks; only `@hiero-ledger/sdk` is allowed). Implement mirror-node fetch/pagination by hand; do not import `@x402/hedera`'s `fetchJson`/`mirrorNodeUrlForNetwork` even though they'd work — the manifest's minimalism is the stated, CI-enforced claim.
- `packages/verifier` must never import `packages/anchor` or its `hash.ts` — it already has its own, independently written `hash.ts`.
- `anchorReceipt()` must never throw or reject. Catch everything (bad key, unreachable HCS, non-canonicalizable receipt) and return `{ ok: false, error }` — "an unanchored receipt is worth more than a lost one."
- DI convention, matching `packages/buyer`'s established pattern: the untestable-offline boundary (real network I/O) is injected as a trailing optional parameter defaulting to the real implementation. For `verify()` that's `fetchImpl: typeof fetch = fetch`. For `anchorReceipt()` that's an `HcsOps`-shaped object (`{ createTopic, submitHash }`) defaulting to the real SDK-backed functions. Everything upstream (hashing, `Client` construction, `PrivateKey.fromString`) stays real in tests, exactly as buyer's tests exercise real offline signing.
- Real `TopicCreateTransaction`/`TopicMessageSubmitTransaction` execution against consensus nodes is not unit-tested — no safe way to fake Hedera consensus locally. Exercised once, for real, in a manual verification task (parallel to manual-buy's Task 3 Step 6).
- Error messages name what's wrong and the offending value (`packages/store/src/config.ts`, `packages/buyer/src/guard.ts`). `main().catch((error) => { console.error(...); process.exitCode = 1; })` CLI convention. `.ts` extensions in relative imports. Vitest, file-adjacent `*.test.ts`. No build step, Node ≥ 24.
- Keep existing type-only imports type-only (`import type { Client } from "@hiero-ledger/sdk"` already in `topic.ts` stays as-is); add new value imports (`TopicCreateTransaction`, `TopicMessageSubmitTransaction`) as a separate import statement, matching this repo's style of splitting type vs. value imports (e.g. `packages/buyer/src/index.ts`).

---

### Task 1: `packages/anchor/src/topic.ts` — `createTopic`, `submitHash`

**Files:**
- Modify: `packages/anchor/src/topic.ts` (currently: `AnchorMessage` interface done, both functions throw `"not implemented"`)
- Test: `packages/anchor/src/topic.test.ts` (new)

**Interfaces:**
- Produces: `createTopic(client: Client): Promise<string>`, `submitHash(client: Client, topicId: string, hash: string): Promise<void>` (both already declared, signatures unchanged), plus one new exported pure helper: `encodeAnchorMessage(hash: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `packages/anchor/src/topic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HASH_VERSION } from "./hash.ts";
import { encodeAnchorMessage } from "./topic.ts";

describe("encodeAnchorMessage", () => {
  it("carries only the version and the hash — no receipt id, no amounts", () => {
    const hash = "a".repeat(64);
    expect(encodeAnchorMessage(hash)).toBe(`{"v":${HASH_VERSION},"h":"${hash}"}`);
  });

  it("produces valid JSON with exactly two keys", () => {
    const parsed = JSON.parse(encodeAnchorMessage("deadbeef"));
    expect(Object.keys(parsed).sort()).toEqual(["h", "v"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- topic.test.ts`
Expected: FAIL — `encodeAnchorMessage` is not exported yet.

- [ ] **Step 3: Implement**

Replace `packages/anchor/src/topic.ts`'s two stub function bodies and add the new import/helper, keeping the existing doc comment and `AnchorMessage` interface exactly as they are:

```ts
import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Client } from "@hiero-ledger/sdk";
import { HASH_VERSION } from "./hash.ts";

// ... AnchorMessage interface stays exactly as-is ...

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

export async function submitHash(client: Client, topicId: string, hash: string): Promise<void> {
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(encodeAnchorMessage(hash))
    .execute(client);
  // getReceipt() throws ReceiptStatusError on a non-SUCCESS status — that
  // throw is what anchorReceipt()'s catch-everything contract relies on.
  await response.getReceipt(client);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- topic.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/anchor/src/topic.ts packages/anchor/src/topic.test.ts
git commit -m "feat(anchor): implement HCS topic create/submit"
```

---

### Task 2: `packages/anchor/src/index.ts` — `anchorReceipt()`

**Files:**
- Modify: `packages/anchor/src/index.ts` (currently: `AnchorResult` interface and the trailing re-exports done, `anchorReceipt` throws `"not implemented"`)
- Test: `packages/anchor/src/index.test.ts` (new)

**Interfaces:**
- Consumes: `hashReceipt` from `./hash.ts` (done); `createTopic`, `submitHash` from `./topic.ts` (Task 1).
- Produces: `anchorReceipt(receipt, opts, hcs?): Promise<AnchorResult>` — the third parameter, `hcs: HcsOps`, is new and optional, defaulting to the real SDK-backed functions; existing callers (none yet) are unaffected. Also produces the new exported `HcsOps` interface.

- [ ] **Step 1: Write the failing tests**

Create `packages/anchor/src/index.test.ts`:

```ts
import type { Client } from "@hiero-ledger/sdk";
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { anchorReceipt } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const RECEIPT = { rail: "hedera", amount: "15000000" };

function fakeHcs(
  overrides: Partial<{
    createTopic: (client: Client) => Promise<string>;
    submitHash: (client: Client, topicId: string, hash: string) => Promise<void>;
  }> = {},
) {
  return {
    createTopic: overrides.createTopic ?? (async () => "0.0.777"),
    submitHash: overrides.submitHash ?? (async () => {}),
  };
}

describe("anchorReceipt", () => {
  it("creates a topic and submits the hash when no topicId is given", async () => {
    const submitted: Array<{ topicId: string; hash: string }> = [];
    const hcs = fakeHcs({
      submitHash: async (_client, topicId, hash) => {
        submitted.push({ topicId, hash });
      },
    });

    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      hcs,
    );

    expect(result).toEqual({ ok: true, hash: hashReceipt(RECEIPT), topicId: "0.0.777" });
    expect(submitted).toEqual([{ topicId: "0.0.777", hash: hashReceipt(RECEIPT) }]);
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
  });

  it("never throws: an invalid operator key becomes {ok:false, error}", async () => {
    const result = await anchorReceipt(
      RECEIPT,
      { operatorId: OPERATOR_ID, operatorKey: "not-a-key" },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("never throws: a receipt that fails canonicalization becomes {ok:false, error}, empty hash", async () => {
    const result = await anchorReceipt(
      { n: 1 }, // numbers are rejected by the canonicalization rule
      { operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fakeHcs(),
    );

    expect(result.ok).toBe(false);
    expect(result.hash).toBe("");
    expect(result.error).toMatch(/not canonicalizable/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/anchor/src/index.test.ts`
Expected: FAIL — `anchorReceipt` throws `"not implemented"`.

- [ ] **Step 3: Implement**

Replace the stub body of `packages/anchor/src/index.ts`, keeping the file's doc comment and `AnchorResult` interface exactly as they are, and keeping the trailing re-exports:

```ts
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { hashReceipt } from "./hash.ts";
import { createTopic, submitHash } from "./topic.ts";

// ... AnchorResult interface stays exactly as-is ...

/** The network-facing seam. Real HCS calls in production; a fake in tests —
 *  the same shape `fetchImpl` plays in packages/buyer, but for the Hedera SDK
 *  boundary instead of HTTP. Client construction and key parsing stay real in
 *  both, matching how buyer's tests exercise real offline signing. */
export interface HcsOps {
  readonly createTopic: (client: Client) => Promise<string>;
  readonly submitHash: (client: Client, topicId: string, hash: string) => Promise<void>;
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
    // No hash is computable at all — report it visibly rather than losing
    // the purchase's anchoring step silently.
    return { ok: false, hash: "", error: describeError(error) };
  }

  try {
    const client = Client.forTestnet().setOperator(
      opts.operatorId,
      PrivateKey.fromString(opts.operatorKey),
    );
    const topicId = opts.topicId ?? (await hcs.createTopic(client));
    await hcs.submitHash(client, topicId, hash);
    return { ok: true, hash, topicId };
  } catch (error) {
    // Anchoring is best-effort: a failed anchor must never block a purchase.
    // The hash is still reported so the caller can retry or log it.
    return { ok: false, hash, error: describeError(error) };
  }
}

// ... trailing re-exports (hashReceipt, canonicalize, HASH_VERSION, createTopic, submitHash, AnchorMessage) stay exactly as-is ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/anchor/src/index.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/anchor/src/index.ts packages/anchor/src/index.test.ts
git commit -m "feat(anchor): implement anchorReceipt() — best-effort, never throws"
```

---

### Task 3: `packages/verifier/src/index.ts` — `verify()`

**Files:**
- Modify: `packages/verifier/src/index.ts` (currently: `Outcome`, `VerifyResult` types and the trailing re-export done, `verify` throws `"not implemented"`)
- Test: `packages/verifier/src/index.test.ts` (new)

**Interfaces:**
- Consumes: `hashReceipt` from `./hash.ts` (done). **Never imports `packages/anchor`.**
- Produces: `verify(receipt, opts, fetchImpl?): Promise<VerifyResult>` — the third parameter, `fetchImpl: typeof fetch = fetch`, is new and optional.

- [ ] **Step 1: Write the failing tests**

Create `packages/verifier/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { verify } from "./index.ts";

const RECEIPT = { rail: "hedera", amount: "15000000" };
const HASH = hashReceipt(RECEIPT);

function page(entries: Array<{ v: number; h: string }>, next: string | null = null): Response {
  const body = {
    messages: entries.map((entry, index) => ({
      message: Buffer.from(JSON.stringify(entry)).toString("base64"),
      consensus_timestamp: `170000000${index}.000000001`,
      sequence_number: index + 1,
    })),
    links: { next },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("verify", () => {
  it("reports a match when the topic carries the receipt's hash", async () => {
    const fetchImpl = (async () => page([{ v: 1, h: HASH }])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(result.computedHash).toBe(HASH);
    expect(result.consensusTimestamp).toBe("1700000000.000000001");
    expect(result.hashscanUrl).toBe("https://hashscan.io/testnet/topic/0.0.777/messages");
  });

  it("reports missing when the topic has messages but none match", async () => {
    const fetchImpl = (async () => page([{ v: 1, h: "0".repeat(64) }])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
    expect(result.consensusTimestamp).toBeUndefined();
  });

  it("reports missing when the topic has never received a message", async () => {
    const fetchImpl = (async () => page([])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });

  it("follows pagination — a match on a later page is still found", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1
        ? page(
            [{ v: 1, h: "0".repeat(64) }],
            "/api/v1/topics/0.0.777/messages?sequencenumber=gt:1",
          )
        : page([{ v: 1, h: HASH }]);
    }) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(call).toBe(2);
  });

  it("queries the testnet mirror node by default, and resolves a relative next link against it", async () => {
    const requested: string[] = [];
    let call = 0;
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      call += 1;
      return call === 1
        ? page([{ v: 1, h: "x" }], "/api/v1/topics/0.0.777/messages?sequencenumber=gt:1")
        : page([]);
    }) as typeof fetch;

    await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(requested[0]).toBe(
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.777/messages?limit=100",
    );
    expect(requested[1]).toBe(
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.777/messages?sequencenumber=gt:1",
    );
  });

  it("skips a malformed message instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            { message: "###not-valid-json###", consensus_timestamp: "1.1", sequence_number: 1 },
          ],
          links: { next: null },
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });

  it("surfaces a mirror node error rather than silently reporting missing", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    await expect(verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/verifier/src/index.test.ts`
Expected: FAIL — `verify` throws `"not implemented"`.

- [ ] **Step 3: Implement**

Replace the stub body of `packages/verifier/src/index.ts`, keeping the file's doc comment, `Outcome` type, and `VerifyResult` interface exactly as they are, and keeping the trailing re-export:

```ts
import { hashReceipt } from "./hash.ts";

// ... Outcome type and VerifyResult interface stay exactly as-is ...

/** Confirmed live (2026-09-08): the mirror node's public REST base URLs. Not
 *  imported from @x402/hedera on purpose — see this package's package.json:
 *  the dependency list is the claim. */
const MIRROR_NODE_URL: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

interface MirrorMessage {
  readonly message: string; // base64
  readonly consensus_timestamp: string;
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
  const base = MIRROR_NODE_URL[network];
  if (!base) {
    throw new Error(`Unsupported network "${network}". Expected "testnet" or "mainnet".`);
  }

  let path: string | null = `/api/v1/topics/${opts.topicId}/messages?limit=100`;
  while (path) {
    const response = await fetchImpl(`${base}${path}`);
    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for topic ${opts.topicId}. ` +
          `Check the topic id and network.`,
      );
    }
    const parsedPage = (await response.json()) as MirrorMessagesPage;

    for (const entry of parsedPage.messages) {
      let decoded: { h?: unknown };
      try {
        decoded = JSON.parse(Buffer.from(entry.message, "base64").toString("utf8"));
      } catch {
        continue; // not our JSON shape — skip rather than fail the whole scan
      }
      if (decoded.h === computedHash) {
        return {
          outcome: "match",
          computedHash,
          consensusTimestamp: entry.consensus_timestamp,
          hashscanUrl: `https://hashscan.io/${network}/topic/${opts.topicId}/messages`,
        };
      }
    }

    // links.next is a relative path, not an absolute URL — confirmed live.
    path = parsedPage.links.next;
  }

  // A hash with no matching message could mean "never anchored" or "anchored
  // for a different version of this receipt, now altered" — but AnchorMessage
  // carries only {v, h}, no receipt id or other correlator (a deliberate
  // privacy choice: "the topic alone tells an observer nothing"). Without a
  // correlator those two cases are indistinguishable from a topic scan, so
  // "altered" is not reachable here; every non-match reports "missing".
  return { outcome: "missing", computedHash };
}

// ... trailing re-export (hashReceipt, canonicalize, HASH_VERSION) stays exactly as-is ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/verifier/src/index.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Confirm the independence guard still passes**

Run: `node scripts/check-verifier-independence.mjs`
Expected: `ok: verifier depends only on @hiero-ledger/sdk` — confirms Step 3 added no new dependency.

- [ ] **Step 7: Commit**

```bash
git add packages/verifier/src/index.ts packages/verifier/src/index.test.ts
git commit -m "feat(verifier): implement verify() against the public mirror node"
```

---

### Task 4: `packages/verifier/src/cli.ts`

**Files:**
- Modify: `packages/verifier/src/cli.ts` (currently: `main` throws `"not implemented"`)

**Interfaces:**
- Consumes: `verify(receipt, opts, fetchImpl?): Promise<VerifyResult>` from `./index.ts` (Task 3).

No new test file — this is a thin I/O entry point, the same convention `packages/buyer/src/cli.ts` already follows (untested directly; its logic lives in the tested `verify()` it calls).

**Design decision:** README's documented usage is `npm run verify -- --receipt ./receipt.json` — no `--topic` flag shown. So the topic id is read from `HCS_TOPIC_ID` (already documented in `.env.example`), with `--topic` and `--network` as optional overrides. This CLI needs no operator credentials — only `HCS_TOPIC_ID` and, optionally, `HEDERA_NETWORK`.

- [ ] **Step 1: Implement**

Replace `packages/verifier/src/cli.ts`'s stub, keeping the file's doc comment:

```ts
import { readFile } from "node:fs/promises";
import { verify } from "./index.ts";

interface Args {
  readonly receiptPath: string;
  readonly topicId: string;
  readonly network?: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  let receiptPath: string | undefined;
  let topicId: string | undefined;
  let network: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--receipt") receiptPath = argv[(i += 1)];
    else if (flag === "--topic") topicId = argv[(i += 1)];
    else if (flag === "--network") network = argv[(i += 1)];
  }

  if (!receiptPath) {
    throw new Error(
      "Missing --receipt <path>. Usage: npm run verify -- --receipt ./receipt.json",
    );
  }

  const resolvedTopicId = topicId ?? env.HCS_TOPIC_ID?.trim();
  if (!resolvedTopicId) {
    throw new Error(
      "No topic to check against: pass --topic 0.0.<id> or set HCS_TOPIC_ID. See .env.example.",
    );
  }

  return { receiptPath, topicId: resolvedTopicId, network: network ?? env.HEDERA_NETWORK?.trim() };
}

async function main(): Promise<void> {
  const { receiptPath, topicId, network } = parseArgs(process.argv.slice(2), process.env);

  const raw = await readFile(receiptPath, "utf8");
  const receipt: unknown = JSON.parse(raw);

  const result = await verify(receipt, { topicId, network });

  console.log(`outcome: ${result.outcome}`);
  console.log(`computed hash: ${result.computedHash}`);
  if (result.consensusTimestamp) console.log(`consensus timestamp: ${result.consensusTimestamp}`);
  if (result.hashscanUrl) console.log(`hashscan: ${result.hashscanUrl}`);

  if (result.outcome !== "match") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

(Keep the existing `main().catch(...)` block if already present verbatim — only the `main()` body and the new `readFile`/`verify`/`parseArgs` machinery are new; the stub's `void verify;` placeholder line is removed since `verify` is now actually used.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/verifier/src/cli.ts
git commit -m "feat(verifier): a runnable CLI — npm run verify"
```

---

### Task 5: Manual end-to-end verification

This step needs a real, funded Hedera testnet account (get one free at https://portal.hedera.com), matching manual-buy's Task 3 Step 6 pattern.

- [ ] **Step 1: Anchor a real receipt**

```bash
node -e '
import("./packages/anchor/src/index.ts").then(async ({ anchorReceipt }) => {
  const receipt = { rail: "hedera", amount: "15000000", note: "manual anchoring test" };
  const result = await anchorReceipt(receipt, {
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
  });
  console.log(JSON.stringify({ ...result, receipt }, null, 2));
});
'
```

Expected: `{"ok": true, "hash": "...", "topicId": "0.0.<new topic>"}`. Save `receipt` (just the receipt object, not the whole result) to `./receipt.json`, and note the `topicId`.

- [ ] **Step 2: Confirm on HashScan**

Open `https://hashscan.io/testnet/topic/<topicId>/messages`. Confirm the newest message's decoded content is `{"v":1,"h":"<the same hash>"}`.

- [ ] **Step 3: Verify independently**

```bash
HCS_TOPIC_ID=0.0.<topicId> npm run verify -- --receipt ./receipt.json
```

Expected: `outcome: match`, the matching hash, a `consensus timestamp:` line, and the same `hashscan:` link. Exit code 0.

- [ ] **Step 4: Confirm the negative case**

Edit `receipt.json` (change `amount`) and rerun Step 3. Expected: `outcome: missing`, exit code 1.

- [ ] **Step 5: Full suite + typecheck + independence guard**

```bash
npm test
npm run typecheck
node scripts/check-verifier-independence.mjs
```

Expected: all green, independence guard still reports only `@hiero-ledger/sdk`.

## Verification (whole plan)

1. `npm test` — full suite passes (baseline 198 tests + new tests from Tasks 1–3).
2. `npm run typecheck` — no errors.
3. `node scripts/check-verifier-independence.mjs` — still `ok: verifier depends only on @hiero-ledger/sdk`.
4. Manual run (Task 5) against real testnet: anchor a receipt → HashScan shows the message → `npm run verify` reports `match` → tampering the receipt reports `missing` with a non-zero exit code — confirms the whole chain (hash → HCS submit → independent re-hash → mirror node lookup) works against the real network, not just mocks.

## Notes carried forward, not blocking

- No `submitKey` is set on the created topic (public write access) — anyone could technically submit to the demo's topic. Given messages carry no PII/amounts and `verify()` only cares whether *a* matching hash exists, this is an acceptable simplification consistent with this project's existing risk posture (raw private key signing, testnet-only, best-effort anchoring) — not a new gap this plan introduces.
- Mirror node message order is left at default (ascending); irrelevant for a low-volume demo topic.
- `topic.ts`'s `createTopic`/`submitHash` bodies (beyond `encodeAnchorMessage`) are exercised only in Task 5's manual step, not CI — disclosed above under Global Constraints, matching the precedent already set by the buyer's manual-verification task.
