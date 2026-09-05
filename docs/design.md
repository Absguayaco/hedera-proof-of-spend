# Design — hedera-proof-of-spend

Written 2026-09-05, at the start of the ETHOnline build window. Records the
decisions taken before any code, and the reasoning, so they can be revisited
deliberately rather than drifted away from.

## The five components

Per the submission, these are the parts written during the event. Everything
else is prior work, consumed rather than extended.

| Component | Package | Deployed |
|---|---|---|
| Hedera x402 store | `packages/store` | Yes — must be publicly reachable |
| Thin Hedera buyer client | `packages/buyer` | No — library |
| Agent-side HCS anchoring | `packages/anchor` | No — library |
| Independent verifier | `packages/verifier` | No — library + CLI |
| End-to-end script | `scripts/e2e.ts` | No — run by the judge |

## Decision: npm workspaces, not a flat package

The load-bearing claim of the submission is that the verifier depends on nothing
of ours. In a flat `src/verify/` layout that is a directory convention — a judge
would have to read imports across files to confirm it. As a workspace it is a
property of `packages/verifier/package.json`, checkable in five seconds.

The same boundary does a second job on the buyer, which claims to be a
purpose-written one-rail client rather than the multi-rail client with rails
deleted. A dependency list containing exactly one rail is evidence for that.

Cost: cross-package TypeScript resolution, paid once by bundling each entry
point separately with esbuild.

## Decision: the two hash implementations are duplicated on purpose

`packages/anchor/src/hash.ts` and `packages/verifier/src/hash.ts` implement the
same rule twice, independently, and must never import each other.

If the verifier reused the anchoring code, "the verifier agrees" would reduce to
"the same function returned the same answer twice". The duplication is the
control. The canonicalisation rule is stated in the README precisely so that the
second implementation can be written from the specification rather than from the
first implementation.

A disagreement between them is a finding to investigate, not a DRY violation to
refactor away.

## Decision: the HCS message carries the hash and nothing else

    { "v": 1, "h": "<lowercase hex sha-256>" }

No receipt id, no amount, no merchant, no line items. A verifier finds its
receipt by scanning the topic for a matching hash.

Including a receipt id would make lookup cheaper and would leak the shape of
activity on the topic. The privacy claim — "the topic alone tells you nothing" —
is only exactly true if the message is only the hash. The cost is accepted:
lookup is a scan.

The `v` tag exists so the canonicalisation rule can change later without
silently invalidating every anchor made under the old one.

## Decision: `@hiero-ledger/sdk` forced to 2.87.0 tree-wide

`@x402/hedera@2.23.0` depends on `@hiero-ledger/sdk` at exactly `2.85.0` — a
hard pin, not a range. The obvious call was to match it, so the tree would hold
one copy. Measuring changed the answer.

`2.85.0` depends on `@hiero-ledger/cryptography@1.19.0`, which depends on
`react-native-get-random-values`, whose peer pulls in `react-native@1000.0.0` —
the placeholder version npm itself warns was published by accident — and with it
metro, the React Native CLI, and `crypto-js`. `cryptography@1.21.0`, which ships
with SDK `2.87.0`, drops all of that and is `@noble`/`@scure` throughout.

So the root `package.json` carries:

    "overrides": { "@hiero-ledger/sdk": "2.87.0" }

which forces one SDK everywhere, including inside `@x402/hedera`. npm reports
`ERESOLVE overriding peer dependency` — expected, and the point of the override.

Measured effect, cumulative with dropping `@x402/paywall`:

| | packages | advisories |
|---|---|---|
| naive install | 1596 | 54 |
| without `@x402/paywall` | 869 | 22 |
| + SDK override to 2.87.0 | **284** | **7** |

**The risk this accepts:** `@x402/hedera@2.23.0` was built against 2.85.0 and is
being run against 2.87.0. Same major, and the override is the only reason the
tree is clean — but it is an override against a publisher's hard pin, so the
first real payment on testnet is the test that matters. If settlement misbehaves
in a way that smells like the SDK, drop the override first before debugging
anything else.

The 7 remaining advisories are all inside the official Hedera stack
(`protobufjs`, `grpc-js`/`ws`, `ethers`/`ws`) plus `qs`. They come with using the
official SDK and are accepted rather than patched.

## Decision: x402 packages pinned at 2.23.0

Latest is 2.25.0, published 2026-09-04. The `min-release-age=7` cooldown in
`.npmrc` would block it — correctly. 2.23.0 was published 2026-08-18 and clears
the window comfortably. `hono` is pinned at 4.13.5 (2026-08-26) for the same
reason; 4.13.7 shipped the day before this repo was created.

**When bumping any dependency, check the publish date first.** A version newer
than seven days will fail to resolve, and the failure does not explain itself.

## Decision: the ledger client lives at the root, not in a package

`@modelcontextprotocol/sdk` is a root dependency used by `scripts/e2e.ts`. The
askReceipts client is demo harness, not one of the five components, and keeping
it at the root keeps it out of all four packages — most importantly out of the
verifier.

## Supply-chain posture

- `min-release-age=7` in `.npmrc` — a poisoned version is typically unpublished
  within hours, so a cooldown blocks it before it can enter the lockfile. This
  is a real npm setting and it works on npm >= 11.10.0.
- A `preinstall` hook refusing npm < 11.10.0, because below that version
  `min-release-age` is ignored **silently**. A security control that appears to
  work but does not is worse than one that fails loudly.

**Correction carried over from payment-rails-buyer:** that repo's `.npmrc` also
sets `strict-allow-scripts=true` and an `allow-scripts[]` list. Those are **not
npm settings**. npm 11.10.0 prints `Unknown project config` for both and ignores
them — the pinned allow-list is decoration, not a control. They are deliberately
absent here rather than copied across, and payment-rails-buyer is worth fixing
for the same reason.

npm's real lever is `ignore-scripts=true`, which is all-or-nothing and would
break esbuild's platform-binary postinstall, so it is not enabled. Audit instead:

    npm ls --all --json | grep -c '"hasInstallScript": true'

**When bumping any dependency, check its publish date first.** A version newer
than seven days will fail to resolve and the failure does not explain itself.

## Open items

1. **Project name.** "Proof of Spend" is a placeholder that appears in
   application fields 01, 03 and 04. The repo is `hedera-proof-of-spend`; a
   rename means changing the repo URL, which is the expensive part.
2. **Seeded demo account.** Step 7 of the walkthrough only shows three rails if
   the shared demo account already holds x402 and MPP receipts. Seeding task,
   not a build task, on the critical path. If it will not be done, cut step 7
   rather than print a one-rail total and call it cross-rail.
