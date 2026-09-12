# hedera-proof-of-spend

**An agent that spends money you can audit without trusting the auditor.**

An AI agent buys from an x402-gated service on Hedera, settling in native HBAR.
Before it pays, the spend *decision* — not just the receipt — is anchored to a
Hedera Consensus Service topic that only this agent's key can write to, and
the purchase does not settle unless that anchor reaches consensus first.
Every purchase is then filed to a receipt ledger, and the agent anchors the
hash of that receipt too. Anyone can take a receipt, hash it themselves, query
Hedera's public mirror node — an unauthenticated REST API, no Hedera account,
no SDK, `curl` is enough — and confirm two things independently: that the
ledger never quietly changed its mind, and that the decision to spend
genuinely predates the money moving.

Why Hedera specifically, not just "a chain": the public mirror node is an
unauthenticated REST API — the two `curl` commands in "How the receipt hash
is computed" below are the entire tool a third party needs, no wallet, no
SDK, no account. That is the argument for a notary layer that happens to be
true of Hedera and would need restating for most other chains.

Concretely: if the agent is told "refuse" and pays anyway, the anchored
refusal plus the on-chain payment is proof the agent disobeyed — the
operator cannot quietly delete the refusal and claim it never happened. If
a spend is disputed later, the anchored approval's consensus timestamp
proves it was authorized *before* the payment settled, not composed
afterward to justify it. If an auditor asks whether spending controls were
real, an anchored refusal cannot be manufactured retroactively — unlike a
list pulled from the ledger's own database the week the auditor calls. And
if a vendor claims a purchase attempt never happened, the anchored decision
names the amount, currency and payee, timestamped, so the vendor can check
it without access to either side's systems. The proof does not come from
us, and checking it does not require trusting us either.

> **Testnet only.** This signs transactions from a private key you supply. It
> refuses to start against any network but `hedera:testnet`. Use a throwaway
> account.

## Why a ledger still has to exist

Three jobs, three layers. **The rail** moves the money. **The ledger** says what
was bought and decides what may be. **The notary** proves the ledger did not
change its mind.

No chain can do the ledger's job: a transfer records an amount and two
addresses, and does not know "coffee" or "3.49 USD". It cannot refuse a purchase
before it happens, and it cannot hold a running total — which matters, because
fifteen payments of 14.99 drain a wallet exactly as one over-cap payment would.
Equally, no database can do the notary's job, because it certifies itself.
Hence both.

## Layout

    packages/store/      x402-gated service on hedera:testnet, quoting in HBAR
    packages/buyer/      thin client — the Hedera exact scheme, and nothing else
    packages/anchor/     agent-side HCS anchoring, best-effort by design
    packages/verifier/   independent verifier — depends on nothing of ours
    scripts/e2e.ts       the seven-step walkthrough

The split is not decoration. Two claims in this project are load-bearing, and
the package boundaries are what make them checkable rather than asserted:

- **`packages/verifier` depends on nothing of ours.** Read its `package.json`:
  one public Hedera SDK, plus `node:crypto`. It cannot reach the anchoring code,
  so "the verifier agrees" means two independent implementations agree.
- **`packages/buyer` speaks exactly one rail.** No rail registry, no funding
  seam, nothing pluggable. It is not a multi-rail client with the other rails
  deleted — its dependency list has only ever had one rail in it.

`packages/anchor/src/hash.ts` and `packages/verifier/src/hash.ts` are duplicates
**on purpose**. Do not refactor one to import the other: the duplication is the
control.

## Prior work

Disclosed upfront, not as an afterthought. Two pieces predate this event.

**payment-rails-lab** was built for the NandaTown hackathon: a rail abstraction
with two working rails (x402 and MPP), the buyer composition, a funding seam,
the receipt contract, a spend cap, a budget guard and their tests. None of it is
in this repository. This submission needs exactly one rail, so it has no rail
interface, no registry and no funding seam — check `packages/buyer`, whose
dependency list has only ever carried one rail.

**askReceipts** is our own hosted receipt ledger, reached over an authenticated
MCP endpoint. It is consumed as a service, not extended, and no part of it is
modified here. Anchoring runs entirely agent-side: the agent files a receipt,
reads it back, hashes it, and submits the hash to HCS. askReceipts never touches
Hedera and does not know anchoring exists.

Everything else in this repository is new, open source, and written during the
event.

## Requirements

- **Node >= 24.** Node 20 reached end of life on 2026-04-30 and 22 ships an npm
  too old for the cooldown below, so 24 is the floor. It also runs TypeScript
  directly, which is why this repo has no build step.
- **npm >= 11.10.0** — Node 24 ships 11.19.0, so this is satisfied out of the
  box. A `preinstall` hook enforces it anyway, for anyone who has pinned an
  older npm by hand: below 11.10.0, npm silently ignores the 7-day
  `min-release-age` cooldown in `.npmrc`, which is this repo's main
  supply-chain defence.

## Run it

    git clone <this repo> && cd hedera-proof-of-spend
    npm ci
    npm run e2e

`npm ci` installs strictly from the committed lockfile and resolves nothing new.
There is no build step: Node 24 executes the TypeScript sources directly.

Only two environment variables are required; everything else defaults to public
infrastructure. See `.env.example`.

## The store

Live at **https://hedera-proof-of-spend-store.vercel.app** — public, no
credentials required:

    curl https://hedera-proof-of-spend-store.vercel.app/menu
    curl -i https://hedera-proof-of-spend-store.vercel.app/buy/espresso   # 402

The second returns a `payment-required` header carrying an x402 challenge for
native HBAR (asset `0.0.0`) on `hedera:testnet`.

### Running it yourself

The demo buys from the hosted deployment, so you do not need this. To run the
seller side locally:

    STORE_PAYEE_ID=0.0.<your account> \
    FACILITATOR_URL=https://api.testnet.blocky402.com \
    npm run start:store

It refuses to start unless the facilitator is reachable *and* settles
`exact/hedera:testnet` — otherwise the store would bind its port, look healthy,
and fail every purchase.

`GET /menu` and `GET /health` are free; discovery must not cost money, or an
agent cannot find out what anything costs without paying first. Every
`GET /buy/<slug>` is gated and answers 402 with a challenge quoting native HBAR
(asset `0.0.0`) in tinybar.

### Buying something by hand

    HEDERA_OPERATOR_ID=0.0.<your account> \
    HEDERA_OPERATOR_KEY=<your private key> \
    npm run buy -- espresso

Buys one item — `espresso`, `flat-white`, or `cold-brew` — from the hosted
store by default, pays the 402 challenge in HBAR, and prints what it paid,
the transaction id, and a HashScan link. Set `STORE_URL` to buy from a
locally-run store instead. No receipt is filed and nothing is anchored to
HCS — this is the buy step on its own, not the full walkthrough.

## Deploying the store

The store runs on Vercel as a single function. `api/index.js` is the deployed
entry point, built by `npm run build` from `packages/store/src/vercel.ts` via
esbuild — the repo's own no-build-step rule stops at the boundary of this one
deploy target; see [`docs/design.md`](docs/design.md) for why. `vercel.json`
routes every path to it, and CI re-runs the build and fails if the committed
`api/index.js` has drifted from its source.

Serverless has no boot, so the guarantee the long-running server gets for free
had to be rebuilt: the first request of each cold start runs the facilitator
preflight, and until it passes every request answers **503 with the reason**. A
deployment that cannot settle payments does not get to look healthy. A failed
preflight is not cached, so a facilitator outage recovers without a redeploy.

Two environment variables must be set in the Vercel project:

    STORE_PAYEE_ID     the Hedera account payments are made to
    FACILITATOR_URL    https://api.testnet.blocky402.com

Node 24 is required and Vercel selects it from `engines` in `package.json`.

## Verify it yourself

1. The agent calls `check_budget` and is told whether it may spend.
2. It requests a resource from the Hedera store, receives a 402, and pays in HBAR.
3. The settled purchase is filed to the ledger (askReceipts), on rail `hedera`,
   so a later `check_budget` call sees the accumulated spend — this is a
   separate, smaller record (merchant, nominal amount, currency, timestamp)
   from the receipt object the next two steps hash and anchor.
4. The agent also builds its own receipt object — the full settled purchase,
   bound to the decision that authorized it — hashes that, and submits the
   hash to the HCS topic.
5. The verifier re-hashes that same receipt object independently and confirms
   the topic agrees.
6. HashScan shows the same message, on a network neither of us controls.
7. A final call returns spend across every rail — x402, MPP and Hedera in one answer.

**Step 6 is the one that matters.** It is the only step whose evidence does
not come from us.

Between steps 5 and 6, the walkthrough also runs an independent **ordering
proof**: it re-verifies the spend *decision*'s own HCS anchor — filed and
confirmed at consensus before the purchase was ever attempted — looks up the
real settlement transaction's consensus timestamp from the same public mirror
node, and confirms the decision's timestamp is strictly earlier. That is what
actually backs the claim that a purchase cannot settle on an unconfirmed
decision: not a code-review argument, a timestamp comparison against a public
ledger neither of us controls, runnable by anyone holding the filed receipt.

The receipt itself carries what a third party needs for both checks: alongside
the settled purchase, it embeds the full spend decision that authorized it —
not just a hash reference to it — and a structured `{nonce, topicId,
sequenceNumber}` pointer back to that decision's own anchor. Hand someone only
the receipt file and they can independently hash the embedded decision,
confirm it against the topic, and re-run the ordering check themselves,
without ever asking us for anything.

To run only the verification half, against a receipt you already hold:

    npm run verify -- --receipt ./receipt.json

This one command checks both: it re-hashes the receipt against the topic
(steps 4-6 above) *and*, when the receipt carries the decision/settlement
reference, runs the same ordering proof the walkthrough does — the decision
anchor and the decision-before-settlement timestamp comparison — printing
the authorizing decision's own verdict, amount and payee, not just a bare
match/no-match.

If you omit `--topic`/`HCS_TOPIC_ID`, this falls back to whatever topic the
receipt itself names — printed with a warning, because that only proves the
hash sits on a topic *someone* owns, not that a *specific* agent anchored it.
Pass `--topic` with a topic id you already know to be this agent's for a check
that actually binds the result to it.

## Why the topic itself can be trusted

Anyone can read an HCS topic. The question is whether anyone can *write* to
one and make `verify()` say "match" for something this agent never anchored.

`packages/anchor` sets a **submit key** on every topic it creates, scoped to
the agent's own key — once set, Hedera's own consensus rules reject any
submission not signed by that key, before it ever reaches consensus. Reusing
an existing topic (via `HCS_TOPIC_ID`) goes through the same check every time:
the agent queries the topic's own submit key from the public mirror node and
refuses to anchor unless it genuinely matches, and refuses a topic that has an
admin key at all — one could have its submit key changed or cleared later,
which would retroactively undo the guarantee for everything already anchored
there. A topic with no submit key, or one owned by a different key, is refused
rather than silently written to.

## How the receipt hash is computed

This is the specification. Both implementations in this repository —
`packages/anchor/src/hash.ts` and `packages/verifier/src/hash.ts` — are written
from *this text*, independently, and never from each other. Anyone can write a
third from it and get the same answer, which is the point.

**Version 1.** The HCS message carries `{"v":1,"h":"<hash>"}`, so this rule can
change later without invalidating anchors made under the old one.

1. **The receipt must be a JSON object.**

2. **Numbers are rejected.** A JSON number has no single spelling — `1`, `1.0`
   and `1e0` are the same value and different text — so a canonicalisation that
   allows them has to legislate for float formatting, and two implementations
   will eventually disagree. Amounts are the one thing in a receipt that must
   not be ambiguous, so they travel as decimal strings. Permitted value types
   are **string, boolean, null, array, and plain object**. Anything else — a
   number, a bigint, a `Date`, a `Map`, a class instance — is an error, not a
   coercion.

   "Plain object" is load-bearing. A `Date` has no own enumerable keys, so an
   implementation that accepts any `typeof "object"` will canonicalize it to
   `{}` and two receipts that differ only in their timestamp will hash the
   same. Objects with a `null` prototype are plain; anything with a different
   prototype is rejected.

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

4. **Array order is preserved.** Order in an array is data, not presentation.

5. **Keys with no value are omitted.** A key explicitly set to `null` is kept,
   because `null` is a value; a key that is absent or `undefined` does not
   appear at all. The two are different receipts.

6. **Serialize as JSON with no insignificant whitespace** — no spaces after
   `:` or `,`, no newlines, no trailing newline. Strings use minimal RFC 8259
   escaping, and non-ASCII characters are emitted literally rather than as
   `\u` escapes.

   One exception: an unpaired (lone) surrogate is emitted as a `\uXXXX`
   escape, not literally, because it has no valid UTF-8 encoding and rule 7
   would otherwise substitute U+FFFD for it. This is what a conforming JSON
   serializer already does — both implementations rely on `JSON.stringify`
   for this, per rule 6's escaping and rule 3's note on the surrogate range.

7. **Encode the result as UTF-8, hash it with SHA-256, and render the digest as
   lowercase hexadecimal.** That string is the receipt hash.

Worked example. This receipt:

    { "rail": "hedera", "amount": "15000000", "item": { "slug": "espresso" } }

canonicalizes to exactly:

    {"amount":"15000000","item":{"slug":"espresso"},"rail":"hedera"}

and the hash is the SHA-256 of those bytes. `npm run e2e` produces a real one
of these, plus the real topic id, sequence number, and HashScan links it
anchors to — run it once and you have your own worked example with numbers
that are actually yours, not ones lifted from this file.

Real evidence, not a constructed example — anchored live on 2026-09-11:

    curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10475837/messages/1

returns a message that decodes to exactly
`{"v":1,"h":"6aa1af6f368868306de6c71c91bea2041ae492cebe72c3c3e7b4dbd7657b8a3b"}`
— on a topic (`0.0.10475837`) whose own `submit_key` is set and whose
`admin_key` is `null`, confirmed by:

    curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10475837

https://hashscan.io/testnet/topic/0.0.10475837/messages shows the same
message, on a network neither of us controls.

## What this proves, and what it does not

- **HCS proves integrity, not truth.** A ledger that files a wrong receipt and
  anchors it has anchored a wrong receipt, immutably. This narrows what you have
  to trust; it does not eliminate it.
- **The anchored decision names the money.** `amount`, `currency` and `payTo`
  come from the store's own live payment challenge at decision time, not a
  cached price — so an anchored approval authorizes a specific amount to a
  specific payee, not "this URL, for any amount, to any payee".
- **The budget guard is advisory for `npm run buy`, and preventive for
  `decideAndBuy()`.** The customer runs the agent, so a direct call to
  `buyResource()` can be refused and used anyway — the ledger only records
  the refusal. `decideAndBuy()` (`scripts/decide-and-buy.ts`) is stricter: it
  anchors the spend decision to HCS *before* paying, and settles nothing
  unless that anchor reaches consensus with an approved verdict — a decline
  is anchored with the same rigor as an approval, not just recorded after
  the fact.
- **The decision provably predates the payment.** See "Verify it yourself"
  above — this is a timestamp comparison against the public mirror node, not
  an assertion about code sequencing.
- **Anchoring is best-effort.** If HCS is unreachable the purchase still
  completes and the receipt is still filed. An unanchored receipt is worth more
  than a lost one, and it is visibly unanchored — the correct failure mode.
- **The topic alone tells you nothing.** Only hashes are published. That is a
  privacy choice, and its cost is that an anchor is meaningless without the
  receipt it fingerprints.

## Licence

MIT — see [LICENSE](LICENSE).
