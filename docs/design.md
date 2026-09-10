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

## Decision: Node 24, and therefore no build step

The first draft of this repo targeted Node 20.
That was wrong on two counts, both found by checking rather than by reasoning:

**Node 20 reached end of life on 2026-04-30** and receives no security updates.
Shipping an EOL runtime next to an `.npmrc` cooldown undercuts the argument the
cooldown is making.

**Node 24 ships npm 11.19.0**, above the 11.10.0 floor where `min-release-age`
is actually enforced. Node 22 ships npm 10.9.8 and would still need a global npm
upgrade in CI and on every contributor's machine, so 22 solves the support-date
problem without solving the npm one.

Node 24 also runs TypeScript directly, so the esbuild bundling step, the
`dist/` directory and the `esbuild` devDependency were all deleted. `npm ci` no
longer runs a `prepare` script, and the entry points are run as sources:

    npm run e2e          -> node scripts/e2e.ts

Verified before committing: type stripping handles both this repo's import
styles — relative imports carrying an explicit `.ts` extension, and workspace
package imports resolving through `node_modules` to a package's `src/index.ts`.

The sources must stay within what type stripping supports: type annotations,
interfaces and `import type` are fine; enums, namespaces and parameter
properties are not, and would silently reintroduce the need for a build step.

If the store's deploy target later wants a single bundled artifact, that is a
reason to bring esbuild back for `packages/store` alone — not for the repo.

**That happened.** The first Vercel deployment failed at runtime with
`ERR_MODULE_NOT_FOUND: /var/task/packages/store/src/config.ts`. Vercel
transpiles a function's own file but does not follow relative `.ts` imports into
other workspace packages, so the deployed function referenced files that were
never uploaded. `npm run build` now bundles `packages/store/src/vercel.ts` into
`api/index.js` with esbuild, and `vercel.json` runs it. Exactly one artifact,
for exactly one deploy target: local development, tests and CI still run the
sources with no build step.

`api/index.js` is committed, not gitignored. The build-on-Vercel approach
failed in practice — remote-debugging a Vercel build log is a five-minute
feedback loop — so the committed bundle removes that failure class instead:
no build command to misfire, no esbuild needed on the build machine, no
dependence on how Vercel orders build output against function detection. The
deploy is a plain `.js` function with traceable imports. Because a committed
artifact can drift from its source silently, CI runs the same build and fails
if the result differs from what is checked in.

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

**A correction, and then a correction to the correction.** This document
previously claimed `allow-scripts` is not an npm setting, on the evidence that
npm 11.10.0 prints `Unknown project config` for it. That evidence was real but
the conclusion was too broad: **npm 11.19.0 implements `allow-scripts`**, and
warns at install time about packages whose install scripts are not yet covered.
It was a Vercel build log — running the newer npm — that surfaced this.

So the setting is version-sensitive rather than fake. Node 24 ships npm 11.19.0,
which this repo requires, so the allow-list is a real control here. On an older
npm it silently does nothing, which is exactly why the preinstall hook refuses
to run below 11.10.0: a control that quietly does not apply is worse than none.

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
