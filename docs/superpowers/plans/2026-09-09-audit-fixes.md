# Five Adversarial-Audit Bugfixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five independently-verified bugs found by an external adversarial audit, without touching anything else. Each bug gets its own commit(s); no bug's fix depends on another except where noted.

**Context:** Two bugs live in `packages/buyer/src/settlement.ts` (Bug 1: dead HashScan link, Bug 5: mislabeled timestamp fields). Fixing both touches the same interface, so they are sequenced as one pair of tasks — Bug 5's rename first, then Bug 1's URL fix built on the renamed fields — rather than in the audit's own priority order. Bugs 2, 3, and 4 are independent and proceed in the audit's stated order. All five were independently verified live/by direct execution against current `main` before this plan (not just trusted from the audit text): a real HashScan page load confirming the dead link and the working alternative, direct execution of both hash implementations against realistic `JSON.parse`'d inputs confirming the `__proto__` collision and the lone-surrogate divergence (reproduced across repeated runs), a real mirror-node lookup against a real settled transaction confirming the timestamp mislabeling, and direct file/git-history reads confirming both `design.md` contradictions.

## Global Constraints

- `.ts` extensions on all relative imports; no build step; Node >= 24; Vitest (`vitest run`), file-adjacent `*.test.ts`.
- `packages/verifier` must gain **zero** new dependencies — enforced by `node scripts/check-verifier-independence.mjs`, which reads `packages/verifier/package.json` directly and allows only `@hiero-ledger/sdk`. None of these fixes need a new dependency; Task 4 (Bug 3) actually *removes* `packages/verifier`'s use of `TextEncoder`, but that was always a Web-standard global, never a manifest dependency, so the guard is unaffected either way — run it anyway after Task 4 as a sanity check.
- Error messages name what's wrong and the offending value (established pattern throughout `packages/anchor/src/hash.ts` and `packages/buyer/src/settlement.ts` — e.g. `Not a Hedera transaction id (got "${raw}")`). No new error paths are introduced by this plan, but existing ones must keep this property after edits.
- `packages/anchor/src/hash.ts` and `packages/verifier/src/hash.ts` must never import each other, and must never import each other's test file. Cross-implementation comparison lives only in `__tests__/hash-agreement.test.ts` at the repo root.
- Match existing commit message convention seen in `git log`: `fix(<package>): <what>`, `docs: <what>`.
- Run `npm run typecheck` and `npm test` (full suite) at the end of every task, not just the files touched — these are small, widely-imported files (`settlement.ts` is re-exported from `packages/buyer/src/index.ts`; `hash.ts` in both packages is exercised by the root-level agreement test).

## What this plan does NOT do

- **Nonce-replay enforcement.** `scripts/decide-and-buy.ts` anchors a nonce but nothing checks for a prior identical one. This is a disclosed, already-known limitation from the decide-and-buy PR, not one of the five confirmed bugs. Not touched here.
- **Documenting the `Decision` schema in README prose.** Same status — a disclosed, already-known gap from the decide-and-buy PR, not a confirmed bug. Not touched here.

Both are out of scope by the task definition, not by omission — implementing either would be scope creep on a bugfix plan.

---

## Task 1: Bug 5 — rename `HederaSettlement.seconds`/`.nanos` to `.validStartSeconds`/`.validStartNanos`

The transaction ID's embedded timestamp is the client-chosen valid-start time, not the network-assigned consensus timestamp (verified live against the mirror node: `valid_start_timestamp` vs. `consensus_timestamp` differ by ~8.68s on a real settled transaction). The current names and doc comment claim otherwise. Confirmed blast radius (grepped): exactly `packages/buyer/src/settlement.ts` (source), `packages/buyer/src/settlement.test.ts`, and `scripts/decide-and-buy.test.ts` (a fixture, line ~68) reference these fields. `packages/buyer/src/index.ts` stores the object opaquely via the `HederaSettlement` type and needs no change.

**Files:**
- Modify: `packages/buyer/src/settlement.ts`
- Modify: `packages/buyer/src/settlement.test.ts`
- Modify: `scripts/decide-and-buy.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `packages/buyer/src/settlement.test.ts` in full:

```ts
import { describe, expect, it } from "vitest";
import { hashscanUrl, parseSettlement } from "./settlement.ts";

describe("parseSettlement", () => {
  it("parses a well-formed Hedera transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(settlement).toEqual({
      transactionId: "0.0.12345@1699999999.123456789",
      feePayer: "0.0.12345",
      validStartSeconds: 1699999999,
      validStartNanos: 123456789,
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

(Only the `parseSettlement` "well-formed" test's expected object changed — `seconds`/`nanos` → `validStartSeconds`/`validStartNanos`. The `hashscanUrl` test is deliberately left asserting the OLD, still-broken URL shape here; it gets rewritten in Task 2, which depends on this task's renamed fields.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/buyer/src/settlement.test.ts`
Expected: FAIL — `parseSettlement`'s "well-formed" test fails, because the current implementation still returns `{ seconds, nanos }`, not `{ validStartSeconds, validStartNanos }`. The `hashscanUrl` test still passes (unchanged, unrelated to this step).

- [ ] **Step 3: Implement**

Replace `packages/buyer/src/settlement.ts` in full:

```ts
/**
 * Hedera does not identify a settled transaction with an EVM transaction hash.
 * It uses a transaction ID: the paying account, then a valid-start time.
 *
 *     0.0.<feePayer>@<seconds>.<nanos>
 *
 * Anything that assumes an 0x-prefixed 32-byte hash will silently mis-store
 * this, which is why parsing lives in its own file with its own tests.
 */
export interface HederaSettlement {
  /** The full transaction ID, exactly as the facilitator reported it. */
  readonly transactionId: string;
  /** Account that paid the fee, e.g. "0.0.12345". */
  readonly feePayer: string;
  /**
   * The transaction's valid-start time, split as encoded in the transaction
   * ID — chosen by the paying client, NOT the network. This is NOT the
   * consensus timestamp; a real consensus timestamp can only come from the
   * mirror node (its `consensus_timestamp` field), and can differ from this
   * by several seconds.
   */
  readonly validStartSeconds: number;
  readonly validStartNanos: number;
}

const TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

// Reject anything not matching TX_ID rather than coercing — a malformed
// settlement reference must fail loudly, not file a bad receipt.
export function parseSettlement(raw: string): HederaSettlement {
  const match = TX_ID.exec(raw);
  if (!match) {
    throw new Error(
      `Not a Hedera transaction id (got "${raw}"). Expected payer@seconds.nanos, ` +
        `e.g. 0.0.12345@1699999999.123456789.`,
    );
  }
  const [, feePayer, seconds, nanos] = match;
  return {
    transactionId: raw,
    feePayer,
    validStartSeconds: Number(seconds),
    validStartNanos: Number(nanos),
  };
}

/** HashScan URL for a transaction, so a receipt can link to third-party proof. */
export function hashscanUrl(settlement: HederaSettlement): string {
  return `https://hashscan.io/testnet/tx/${settlement.transactionId}`;
}
```

(`hashscanUrl`'s body is deliberately left unchanged here — still using `transactionId` and the broken `/tx/` shape. Task 2 fixes it, building on `validStartSeconds`/`validStartNanos`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- packages/buyer/src/settlement.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Update the downstream fixture**

In `scripts/decide-and-buy.test.ts`, find the `PURCHASE` constant and update its `settlement` field:

```ts
const PURCHASE: BuyResult = {
  body: { item: { slug: "espresso" } },
  amountTinybar: 15_000_000n,
  settlement: {
    transactionId: "0.0.99999@1700000000.123456789",
    feePayer: "0.0.11111",
    validStartSeconds: 1700000000,
    validStartNanos: 123456789,
  },
};
```

(Only the `settlement` object's last two fields change name — everything else in the file, and every other line of `PURCHASE`, is untouched.)

- [ ] **Step 6: Run to verify it still passes**

Run: `npm test -- scripts/decide-and-buy.test.ts`
Expected: PASS, unchanged test count (this fixture rename doesn't change any assertion's outcome — `decideAndBuy` never inspects settlement fields, it only round-trips `BuyResult` from the injected `buyResourceImpl`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Full suite**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 9: Commit**

```bash
git add packages/buyer/src/settlement.ts packages/buyer/src/settlement.test.ts scripts/decide-and-buy.test.ts
git commit -m "fix(buyer): rename settlement seconds/nanos to validStartSeconds/validStartNanos

Verified against a real settled testnet transaction via the public mirror
node: the timestamp embedded in a Hedera transaction ID is the client-chosen
valid-start time (the mirror node's valid_start_timestamp field), not the
network-assigned consensus timestamp (consensus_timestamp), which can differ
by several seconds and is the only value that actually proves when/whether a
transaction reached consensus. The old field names and doc comment claimed
'Consensus timestamp, split as Hedera reports it' -- false. Renamed and
re-documented so nothing downstream can mistake a client-supplied value for a
network-assigned one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Rj9p2ikQ9QVNbbvjMHenN"
```

---

## Task 2: Bug 1 — fix the dead HashScan transaction link

Depends on Task 1 (uses `validStartSeconds`/`validStartNanos`). Verified live in a browser: `https://hashscan.io/testnet/tx/<transactionId>` (dots, word "tx") renders every field as "None"; `https://hashscan.io/testnet/transaction/<feePayer>-<seconds>-<nanos>` (dashes, word "transaction") renders the real transaction. Confirmed against `0.0.7162784@1788825896.303987758` → dash form `0.0.7162784-1788825896-303987758`.

**Files:**
- Modify: `packages/buyer/src/settlement.ts`
- Modify: `packages/buyer/src/settlement.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/buyer/src/settlement.test.ts`, replace the `describe("hashscanUrl", ...)` block:

```ts
describe("hashscanUrl", () => {
  it("builds the testnet transaction link with dashes, not the transaction id's dots", () => {
    // Verified live: https://hashscan.io/testnet/tx/<id> (dots, word "tx")
    // renders every field as "None". https://hashscan.io/testnet/transaction/
    // <dashed> (dashes, word "transaction") renders the real transaction.
    // Confirmed against a real settled testnet transaction.
    const settlement = parseSettlement("0.0.7162784@1788825896.303987758");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784-1788825896-303987758",
    );
  });

  it("does not dash-replace the dots inside the fee payer's account id", () => {
    // A naive transactionId.replaceAll(".", "-") would also mangle
    // "0.0.12345" into "0-0-12345". Building the URL from the already-parsed
    // fields avoids that.
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.12345-1699999999-123456789",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- packages/buyer/src/settlement.test.ts`
Expected: FAIL — both new assertions fail; the current implementation still returns the `/tx/<transactionId>` (dotted) shape.

- [ ] **Step 3: Implement**

In `packages/buyer/src/settlement.ts`, replace the `hashscanUrl` function:

```ts
/**
 * HashScan URL for a transaction, so a receipt can link to third-party proof.
 *
 * Verified live: https://hashscan.io/testnet/tx/<transactionId> (dots, word
 * "tx") renders every field as "None" -- broken. HashScan actually expects
 * https://hashscan.io/testnet/transaction/<feePayer>-<seconds>-<nanos>
 * (dashes, word "transaction"). Built from the already-parsed fields, not by
 * string-replacing dots in transactionId, which would also mangle the dots
 * inside the shard.realm.num fee-payer account id.
 */
export function hashscanUrl(settlement: HederaSettlement): string {
  return `https://hashscan.io/testnet/transaction/${settlement.feePayer}-${settlement.validStartSeconds}-${settlement.validStartNanos}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- packages/buyer/src/settlement.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: full suite green. (`packages/buyer/src/cli.ts` calls `hashscanUrl(result.settlement)` — its own behavior is unchanged by this fix beyond printing a correct URL; no test asserts CLI stdout content, so no other file needs updating.)

- [ ] **Step 7: Commit**

```bash
git add packages/buyer/src/settlement.ts packages/buyer/src/settlement.test.ts
git commit -m "fix(buyer): point hashscanUrl at HashScan's real transaction URL shape

Verified live in a browser: https://hashscan.io/testnet/tx/<transactionId>
(dots, word 'tx') renders every field as 'None'. HashScan actually expects
https://hashscan.io/testnet/transaction/<feePayer>-<seconds>-<nanos> (dashes,
word 'transaction'), confirmed against a real settled testnet transaction.
Built from the already-parsed feePayer/validStartSeconds/validStartNanos
fields rather than string-replacing dots in transactionId, which would also
mangle the dots inside the shard.realm.num fee-payer account id.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Rj9p2ikQ9QVNbbvjMHenN"
```

---

## Task 3: Bug 2 — `__proto__` causes a silent hash collision in the anchor

Independent of Tasks 1–2. `canonicalValue`'s object branch builds `result` as a plain `{}` object literal; assigning to the literal key `"__proto__"` via bracket notation invokes `Object.prototype`'s `__proto__` accessor (a setter) instead of creating an own property, so the assignment silently vanishes. This only reproduces with a `JSON.parse`'d input — a hand-written `{ __proto__: "x" }` object literal never has `__proto__` as an own key at all, so it wouldn't exercise the bug. Verified live: `Object.create(null)` genuinely fixes it (bracket-notation assignment to any string key, including `"__proto__"`, always creates a real own property on a null-prototype object) and typechecks cleanly under this repo's strict tsconfig.

**Files:**
- Modify: `packages/anchor/src/hash.ts`
- Modify: `packages/anchor/src/hash.test.ts`
- Modify: `__tests__/hash-agreement.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/anchor/src/hash.test.ts`, add a new `describe` block (place it after the `"rule 3 — keys sorted by code point"` block, before `"rule 4 — array order is preserved"`):

```ts
describe("a __proto__ key from JSON.parse is not silently lost", () => {
  it("canonicalize includes __proto__ as a real key, not the object's prototype", () => {
    // A hand-written `{ __proto__: "x" }` object literal never has
    // "__proto__" as an own key at all -- object-literal syntax treats it as
    // setting the prototype. JSON.parse is different: it genuinely creates
    // an own, enumerable "__proto__" property. That's the only realistic way
    // this key ever reaches canonicalize (a receipt arrives via JSON.parse),
    // and it's the only construction that reproduces the bug.
    const receipt = JSON.parse('{"a":"1","__proto__":"x"}') as unknown;
    expect(Object.hasOwn(receipt as object, "__proto__")).toBe(true);
    expect(canonicalize(receipt)).toBe('{"__proto__":"x","a":"1"}');
  });

  it("hashes differently from the same receipt without __proto__", () => {
    const withProto = JSON.parse('{"a":"1","__proto__":"x"}') as unknown;
    expect(hashReceipt(withProto)).not.toBe(hashReceipt({ a: "1" }));
  });
});
```

In `__tests__/hash-agreement.test.ts`, add an entry to the `corpus` array (insert after `["key that is a prefix of another", ...]`, before `["deep nesting", ...]`):

```ts
  [
    "a __proto__ key from JSON.parse, not an object literal",
    JSON.parse('{"a":"1","__proto__":"x"}'),
  ],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/anchor/src/hash.test.ts __tests__/hash-agreement.test.ts`
Expected: FAIL —
- `packages/anchor/src/hash.test.ts`'s new block: `canonicalize(receipt)` currently returns `'{"a":"1"}'` (the `__proto__` key silently vanishes), so the first assertion fails; and `hashReceipt(withProto)` currently equals `hashReceipt({ a: "1" })` (the collision), so the second assertion (`not.toBe`) fails.
- `__tests__/hash-agreement.test.ts`'s new corpus entry: `anchor.canonicalize` and `verifier.canonicalize` disagree on this input (the anchor drops `__proto__`, the verifier — which emits text directly, never assigning into a plain-object accumulator — does not), so both `it.each` assertions for this entry fail.

- [ ] **Step 3: Implement**

In `packages/anchor/src/hash.ts`, in the `canonicalValue` function's object branch, change the `result` accumulator's initialization from `{}` to `Object.create(null)`. Full function for context:

```ts
function canonicalValue(value: unknown, path: string): Canonical {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return value as string | boolean;
  }

  if (type === "number" || type === "bigint") {
    // Rule 2. A number has no single spelling, and the field most likely to be
    // one is an amount — exactly where two implementations must not diverge.
    throw new Error(
      `Receipt is not canonicalizable: ${path} is ${describe(value)}. ` +
        `Numbers are rejected; amounts travel as decimal strings.`,
    );
  }

  if (Array.isArray(value)) {
    // Rule 4: order in an array is data, so it is preserved.
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }

  if (type === "object") {
    // Only plain objects. A Date, Map, Set or class instance is typeof "object"
    // with no own enumerable keys, so without this check it would canonicalize
    // to "{}" — two receipts differing only in a timestamp would hash the same.
    // Silent loss of a field is the worst outcome available here.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        `Receipt is not canonicalizable: ${path} is ${describe(value)}, ` +
          `which the rule does not permit. Convert it to a string first.`,
      );
    }

    const source = value as Record<string, unknown>;
    // Object.create(null), not {} -- a plain {} has Object.prototype's
    // __proto__ accessor, so result["__proto__"] = ... silently sets the
    // prototype instead of creating an own property, and a receipt that
    // genuinely has a "__proto__" key (real, reachable via JSON.parse) loses
    // it without error. A null-prototype object has no such accessor, so
    // bracket-notation assignment to any string key always creates a real
    // own property.
    const result: { [key: string]: Canonical } = Object.create(null);

    // Rule 3, plus rule 5: a key whose value is undefined is omitted entirely.
    // JSON.stringify emits keys in insertion order, so inserting them sorted
    // is what makes the output canonical.
    for (const key of Object.keys(source).sort(byCodePoint)) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = canonicalValue(entry, path === "" ? key : `${path}.${key}`);
    }
    return result;
  }

  throw new Error(
    `Receipt is not canonicalizable: ${path} is ${describe(value)}, which the rule does not permit.`,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/anchor/src/hash.test.ts __tests__/hash-agreement.test.ts`
Expected: PASS. `JSON.stringify` on a null-prototype object works exactly as on a plain one (it only inspects own enumerable properties, never the prototype chain), so no other assertion in either file changes behavior.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`Object.create(o: object | null): any` — TypeScript's overload for a `null` argument returns `any`, assignable to the explicitly-typed `const result: { [key: string]: Canonical }`. Verified directly against this repo's tsconfig before writing this plan.)

- [ ] **Step 6: Full suite and independence guard**

```bash
npm test
node scripts/check-verifier-independence.mjs
```

Expected: full suite green; guard reports only `@hiero-ledger/sdk` (this task never touches `packages/verifier`).

- [ ] **Step 7: Commit**

```bash
git add packages/anchor/src/hash.ts packages/anchor/src/hash.test.ts __tests__/hash-agreement.test.ts
git commit -m "fix(anchor): use a null-prototype accumulator so a real __proto__ key survives canonicalization

canonicalValue's object branch built its output as a plain {} object literal.
Assigning to the literal key \"__proto__\" via bracket notation invokes
Object.prototype's __proto__ accessor (a setter) instead of creating an own
property, so the assignment silently vanished. Verified live: for a
JSON.parse'd receipt genuinely containing an own \"__proto__\" key (JSON.parse
creates one; a hand-written {__proto__: \"x\"} object literal never does, so
it can't reproduce this), canonicalize/hashReceipt silently produced the same
hash as the receipt without that key -- a real collision. packages/verifier's
hash.ts was never affected: it emits text directly rather than assigning into
an intermediate object, so it never triggers the accessor. Object.create(null)
has no prototype at all, so bracket-notation assignment to any string key,
including \"__proto__\", always creates a genuine own property.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Rj9p2ikQ9QVNbbvjMHenN"
```

---

## Task 4: Bug 3 — lone-surrogate keys sort differently between the two implementations

Independent of Tasks 1–3. `packages/anchor/src/hash.ts`'s `byCodePoint` (code-point comparison) and `packages/verifier/src/hash.ts`'s `byUtf8Bytes` (UTF-8-byte comparison) disagree for a key containing a lone (unpaired) surrogate: `TextEncoder` cannot represent one in valid UTF-8 and substitutes U+FFFD, which sorts on the wrong side of a neighboring key like U+E000. Verified live and reproducibly (repeated runs, consistent) with keys `"\ud800"` and `"\ue000"`.

**Decision: fix the verifier by switching to code-point comparison, not by hand-rolling a lone-surrogate-aware UTF-8 encoder.** Reasoning: this project's "independent implementation" claim (README, `docs/design.md`) is about not sharing code and not reasoning from the same starting point — not about every sub-technique being maximally divergent. The rest of the file's architecture (text-emission vs. tree-building, filter-then-sort vs. loop-with-continue, delegating RFC 8259 escaping to `JSON.stringify`) stays genuinely independent regardless of which technique the key comparator uses. Hand-rolling a non-standard encoder to preserve independence on this one already-narrow point would be solving a problem the project's own stated definition of "independent" doesn't actually have.

**Files:**
- Modify: `packages/verifier/src/hash.ts`
- Modify: `packages/verifier/src/hash.test.ts`
- Modify: `__tests__/hash-agreement.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing tests**

In `packages/verifier/src/hash.test.ts`, add a test inside the existing `describe("rule 3 — key order", ...)` block, after the astral-plane-keys test:

```ts
  it("orders a lone surrogate by its raw code point value, not a UTF-8 substitution", () => {
    // U+D800 is a lone (unpaired) high surrogate: a valid Unicode code
    // point, but not a valid Unicode scalar value, so real UTF-8 cannot
    // represent it. JSON.stringify escapes it as the literal text \ud800
    // rather than embedding the raw code unit. U+E000 is an ordinary, valid
    // Private Use Area code point and is emitted literally, per rule 6.
    //
    // By raw code point value, D800 (55296) sorts before E000 (57344).
    const receipt = { "\ud800": "1", "\ue000": "2" };
    const out = canonicalize(receipt);
    expect(out.indexOf("\\ud800")).toBeLessThan(out.indexOf("\ue000"));
  });
```

In `__tests__/hash-agreement.test.ts`, add an entry to the `corpus` array (insert after the new `["a __proto__ key from JSON.parse, ...]"` entry from Task 3, before `["deep nesting", ...]`):

```ts
  [
    "a lone surrogate key sorts by raw code point, not UTF-8 substitution",
    JSON.parse('{"\\ud800":"1","\ue000":"2"}'),
  ],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- packages/verifier/src/hash.test.ts __tests__/hash-agreement.test.ts`
Expected: FAIL —
- `packages/verifier/src/hash.test.ts`'s new test: the current `byUtf8Bytes` sorts `"\ue000"` before `"\ud800"` (UTF-8 bytes for the U+FFFD substitution of `\ud800` are `EF BF BD`; for `\ue000` they are `EE 80 80`; `EF (239) > EE (238)`, so `\ud800` sorts *after* `\ue000`, inverting the expected order), so `indexOf("\\ud800")` is *not* less than `indexOf("\ue000")`.
- `__tests__/hash-agreement.test.ts`'s new corpus entry: `anchor.canonicalize` (code-point order: `\ud800` first) and `verifier.canonicalize` (UTF-8-byte order: `\ue000` first) disagree, so both `it.each` assertions for this entry fail.

- [ ] **Step 3: Implement**

Replace `packages/verifier/src/hash.ts` in full:

```ts
/**
 * A DELIBERATE REIMPLEMENTATION of the receipt hash.
 *
 * This file duplicates packages/anchor/src/hash.ts on purpose. It must never
 * import it. If the verifier reused the anchoring code, then "the verifier
 * agrees" would only mean "the same function returned the same answer twice",
 * which proves nothing at all.
 *
 * Written from the rule as stated in the README, not from the other file.
 * If these two ever disagree, that is a finding, not a bug to paper over by
 * making one import the other.
 *
 * The two take different routes on purpose, for everything except one narrow
 * point. The anchor rebuilds a value tree with ordered keys and hands it to
 * JSON.stringify; this one walks the value and emits the text itself, and
 * nothing here relies on JSON.stringify preserving insertion order. That
 * remains genuinely independent.
 *
 * Key order (rule 3) is the one exception, and it is deliberate, not an
 * oversight. This file originally derived key order from UTF-8 byte order
 * instead of from an array of code points, on the premise that "UTF-8 byte
 * order and Unicode code point order are the same order" -- true for
 * well-formed text, false for a lone (unpaired) UTF-16 surrogate, which
 * TextEncoder cannot represent in valid UTF-8 and silently substitutes
 * U+FFFD for, corrupting the order. Preserving byte-order-as-a-technique
 * through that edge case would mean hand-rolling a non-standard encoder for
 * a case vanishingly unlikely in a real receipt, purely to keep this one
 * sub-technique divergent from the anchor's. The independence claim this
 * project actually makes -- stated in the README and in docs/design.md -- is
 * about not sharing CODE and not reasoning from the same starting point, not
 * about every sub-technique being maximally divergent. So this file now
 * compares keys the same way the anchor does (by code point, via
 * Array.from + codePointAt), written fresh from first principles rather
 * than copied from the other file. Everything else in this file -- emitting
 * text directly instead of building a tree, filtering-then-sorting instead
 * of a loop-with-continue, delegating RFC 8259 escaping to JSON.stringify --
 * remains genuinely independent.
 *
 * One component is honestly shared: both call JSON.stringify on individual
 * *strings* for RFC 8259 escaping (rule 6). Hand-rolling escaping twice would
 * risk two subtly different treatments of control characters and lone
 * surrogates, which is a worse trade than depending on the platform for a
 * well-specified transformation.
 *
 * Imports allowed here: node: builtins only.
 */
import { createHash } from "node:crypto";

export const HASH_VERSION = 1;

/**
 * Sort by Unicode code point, per rule 3.
 *
 * A code point's raw numeric value, not its UTF-8 encoding, is what "sorted
 * by Unicode code point" means -- including a value in the surrogate range
 * D800-DFFF for an unpaired surrogate, which has no valid UTF-8 encoding at
 * all. Array.from() splits a string into code points (rather than UTF-16
 * code units, which would sort astral-plane characters wrong), so reading
 * each one off with codePointAt() and comparing the numbers directly is the
 * one representation this rule can be applied to without going through an
 * intermediate encoding that might not be able to represent every value.
 */
function byCodePoint(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);

  for (let index = 0; index < shared; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** True for a bare `{}`-style object; false for Date, Map, class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reject(path: string, why: string): never {
  const where = path === "" ? "the receipt" : path;
  throw new Error(`Receipt is not canonicalizable: ${where} ${why}`);
}

/**
 * Append the canonical text of `value` to `out`.
 *
 * Emitting fragments rather than building an intermediate structure means the
 * key ordering and the serialization happen in one pass, and nothing relies on
 * JSON.stringify preserving insertion order.
 */
function emit(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "string":
      // Rule 6: minimal RFC 8259 escaping, non-ASCII left literal.
      out.push(JSON.stringify(value));
      return;

    case "boolean":
      out.push(value ? "true" : "false");
      return;

    case "number":
      // Rule 2.
      reject(path, `is the number ${value}. Numbers are rejected; amounts travel as strings.`);
    // falls through to reject, which never returns
    case "bigint":
      reject(path, `is a bigint. Numbers are rejected; amounts travel as strings.`);
    case "undefined":
      // Only reachable inside an array; object keys are filtered before this.
      reject(path, "is undefined, which has no canonical form inside an array.");
    case "function":
    case "symbol":
      reject(path, `is a ${typeof value}, which the rule does not permit.`);
  }

  if (Array.isArray(value)) {
    // Rule 4: order is data.
    out.push("[");
    value.forEach((entry, index) => {
      if (index > 0) out.push(",");
      emit(entry, `${path}[${index}]`, out);
    });
    out.push("]");
    return;
  }

  if (!isPlainObject(value)) {
    // Rule 2's plain-object clause. A Date has no own enumerable keys, so
    // accepting it here would emit "{}" and lose the timestamp silently.
    const name = (value as object).constructor?.name ?? "object";
    reject(path, `is ${name === "Object" ? "a non-plain object" : `an instance of ${name}`}.`);
  }

  // Rule 5: a key whose value is undefined is omitted entirely, which is not
  // the same as a key set to null.
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(byCodePoint);

  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    emit(value[key], path === "" ? key : `${path}.${key}`, out);
  });
  out.push("}");
}

/** Canonical JSON text for a receipt, per the README's rule. */
export function canonicalize(receipt: unknown): string {
  if (!isPlainObject(receipt)) {
    // Rule 1.
    throw new Error("Receipt is not canonicalizable: the receipt must be a JSON object.");
  }
  const out: string[] = [];
  emit(receipt, "", out);
  return out.join("");
}

/** SHA-256 of the canonical bytes, lowercase hex. Rule 7. */
export function hashReceipt(receipt: unknown): string {
  return createHash("sha256").update(canonicalize(receipt), "utf8").digest("hex");
}
```

(Changes from the current file: the top doc comment's independence explanation is rewritten to be accurate; `const utf8 = new TextEncoder();` and `byUtf8Bytes` are removed entirely — `TextEncoder` was only ever used for key sorting, and `hashReceipt`'s UTF-8 encoding is done separately via `createHash(...).update(text, "utf8")`, unaffected by this change; `byCodePoint` replaces it; `.sort(byUtf8Bytes)` → `.sort(byCodePoint)`. Verified live: this comparator correctly sorts `"\ud800"` (55296) before `"\ue000"` (57344).)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- packages/verifier/src/hash.test.ts __tests__/hash-agreement.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full suite and independence guard**

```bash
npm test
node scripts/check-verifier-independence.mjs
```

Expected: full suite green; guard still reports only `@hiero-ledger/sdk` (removing an in-file use of the built-in `TextEncoder` global changes no dependency manifest).

- [ ] **Step 7: Update the README's canonicalization spec**

In `README.md`, find rule 3 under `## How the receipt hash is computed` (currently, lines 176-178):

```
3. **Object keys are sorted by Unicode code point,** ascending, at every level
   of nesting. Note this is code point order, not UTF-16 code unit order; they
   differ above the basic multilingual plane.
```

Replace with:

```
3. **Object keys are sorted by Unicode code point,** ascending, at every level
   of nesting. Note this is code point order, not UTF-16 code unit order; they
   differ above the basic multilingual plane.

   "Unicode code point" here means the raw code point value — including a
   value in the surrogate range D800–DFFF for an unpaired (lone) surrogate,
   which is a valid Unicode code point even though it is not a valid Unicode
   scalar value and has no valid UTF-8 encoding. A comparator that sorts by
   UTF-8 bytes instead of by the code point's numeric value gets this case
   wrong, because UTF-8 cannot represent a lone surrogate and must substitute
   a different character (U+FFFD) for it, which can sort on the wrong side of
   a neighboring key. Sort by the number, not by an encoding of it.
```

This is a documentation-only edit — no test covers README prose directly; `__tests__/hash-agreement.test.ts`'s new corpus entry (Step 1) is what proves both implementations now actually follow this clarified rule.

- [ ] **Step 8: Commit**

```bash
git add packages/verifier/src/hash.ts packages/verifier/src/hash.test.ts __tests__/hash-agreement.test.ts README.md
git commit -m "fix(verifier): sort keys by code point, not UTF-8 bytes -- fixes lone-surrogate ordering

byUtf8Bytes and the anchor's byCodePoint disagreed for any key containing a
lone (unpaired) UTF-16 surrogate. Verified live and reproducibly: for keys
\"\\ud800\" (a lone high surrogate -- a valid Unicode code point, not a valid
Unicode scalar value) and \"\\ue000\" (an ordinary Private-Use-Area code
point), the anchor correctly sorts \\ud800 (55296) before \\ue000 (57344) by
raw code point value; the verifier sorted them the other way, because
TextEncoder cannot represent a lone surrogate in valid UTF-8 and substitutes
U+FFFD (65533) for it per the WHATWG Encoding spec, and 65533 > 57344.

Fixed by switching the verifier to the same code-point-comparison technique
the anchor uses (Array.from + codePointAt), written fresh rather than copied.
This project's independence claim (README, docs/design.md) is about not
sharing code and not reasoning from the same starting point, not about every
sub-technique being maximally divergent -- the rest of this file's
architecture (text-emission vs. tree-building, filter-then-sort vs.
loop-with-continue, delegating RFC 8259 escaping to JSON.stringify) stays
genuinely independent. Also clarifies README rule 3 to state explicitly that
'Unicode code point' includes the surrogate range for an unpaired surrogate,
so a third implementation written from the spec text alone agrees too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Rj9p2ikQ9QVNbbvjMHenN"
```

---

## Task 5: Bug 4 — `docs/design.md` contradicts the repo in two places

Independent of Tasks 1–4. Docs-only fix: no code changes, no new tests. Both passages became false due to later, deliberate, already-committed decisions (commit `693c0d3`, "fix: commit the vercel bundle so the deploy needs no build"; PR #2, "Enforce the allow-script list, and complete it") that never got `design.md` updated to match. Both source texts verified directly (`git show --format=%B 693c0d3`; PR #2's actual description; the current `.npmrc`'s actual four-entry allow-list: `esbuild@0.28.1`, `fsevents@2.3.3`, `protobufjs@7.6.6`, `protobufjs@8.0.1`).

**Files:**
- Modify: `docs/design.md`

- [ ] **Step 1: Fix the `api/index.js` claim**

In `docs/design.md` (currently line 72, end of the paragraph beginning `**That happened.**`), replace:

```
sources with no build step. `api/index.js` is generated and gitignored.
```

with:

```
sources with no build step.

`api/index.js` is committed, not gitignored. The build-on-Vercel approach
failed in practice — remote-debugging a Vercel build log is a five-minute
feedback loop — so the committed bundle removes that failure class instead:
no build command to misfire, no esbuild needed on the build machine, no
dependence on how Vercel orders build output against function detection. The
deploy is a plain `.js` function with traceable imports. Because a committed
artifact can drift from its source silently, CI runs the same build and fails
if the result differs from what is checked in.
```

- [ ] **Step 2: Fix the `strict-allow-scripts` claim**

In `docs/design.md` (currently lines 179–181), replace:

```
`strict-allow-scripts` is a separate key and has not been verified on 11.19.0;
it is not used here rather than assumed to work.
```

with:

```
**Correction again.** `strict-allow-scripts` IS enabled (`.npmrc`) and has
been measured on npm 11.19.0, by PR #2 ("Enforce the allow-script list, and
complete it"). Measured against a dependency with an unlisted `postinstall`:
with the allow-list alone and no `strict-allow-scripts`, npm prints
`install-scripts ... not yet covered by allowScripts` — and runs the script
anyway. With `strict-allow-scripts=true`, the same install stops with
`ESTRICTALLOWSCRIPTS` and the script does not run. Same list both times — the
setting is what turns the list from a note into a control.

Turning it on found the list itself was incomplete: `fsevents@2.3.3` declares
an install script and was missing. It is `os: ["darwin"]` and optional, so it
is absent on the `ubuntu-latest` CI runner and present on any macOS checkout —
enforcement without it would have passed CI and broken every Mac. `.npmrc` now
lists all four packages that declare install scripts for this lockfile on
both platforms: `esbuild@0.28.1`, `fsevents@2.3.3`, `protobufjs@7.6.6`,
`protobufjs@8.0.1`.
```

(Matches the file's own established "correction, and then a correction to the correction" voice from the paragraph immediately preceding this one, and accurately reflects PR #2's measured before/after and the current `.npmrc`'s actual four-entry allow-list.)

- [ ] **Step 3: Sanity check — nothing else broke**

```bash
npm test
npm run typecheck
```

Expected: full suite green, no errors. (Docs-only change; this step exists to confirm the edit didn't accidentally touch anything executable — `docs/design.md` is prose, not parsed by any test or the type checker.)

- [ ] **Step 4: Commit**

```bash
git add docs/design.md
git commit -m "docs: correct two design.md claims that later decisions made false

api/index.js is committed on purpose (693c0d3, 'commit the vercel bundle so
the deploy needs no build'), not generated-and-gitignored as this doc still
claimed -- git ls-files confirms it's tracked and .gitignore has no api/
entry. strict-allow-scripts=true is enforced and was verified exactly as PR
#2 ('Enforce the allow-script list, and complete it') describes -- this doc
still said it 'has not been verified... is not used here', contradicting the
.npmrc it sits three lines above. Both became stale because a later commit
changed the underlying decision without updating this document to match.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Rj9p2ikQ9QVNbbvjMHenN"
```

## Verification (whole plan)

1. `npm test` — full suite passes after every task (baseline + new tests from Tasks 1–4).
2. `npm run typecheck` — clean after every task.
3. `node scripts/check-verifier-independence.mjs` — clean after Tasks 3 and 4 (the only ones touching `packages/verifier`).
4. All five bugs were verified live/by direct execution against the real repo and, where applicable, the real network before this plan was written — this plan's tests are what lock each verification in as a permanent regression check.
