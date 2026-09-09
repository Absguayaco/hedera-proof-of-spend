# hedera-proof-of-spend

**An agent that spends money you can audit without trusting the auditor.**

An AI agent buys from an x402-gated service on Hedera, settling in native HBAR.
Every purchase is filed to a receipt ledger — and the agent anchors the hash of
each receipt to a Hedera Consensus Service topic. Anyone can take a receipt,
hash it themselves, and confirm the ledger never quietly changed its mind. The
proof does not come from us.

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

The store runs on Vercel as a single function. `api/index.ts` is the entry
point and `vercel.json` routes every path to it.

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
3. The settled purchase is filed as a receipt on rail `hedera`.
4. The agent hashes that receipt and submits the hash to the HCS topic.
5. The verifier re-hashes the receipt independently and confirms the topic agrees.
6. HashScan shows the same message, on a network neither of us controls.
7. A final call returns spend across every rail — x402, MPP and Hedera in one answer.

**Step 6 is the one that matters.** It is the only step whose evidence does not
come from us.

To run only the verification half, against a receipt you already hold:

    npm run verify -- --receipt ./receipt.json

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

7. **Encode the result as UTF-8, hash it with SHA-256, and render the digest as
   lowercase hexadecimal.** That string is the receipt hash.

Worked example. This receipt:

    { "rail": "hedera", "amount": "15000000", "item": { "slug": "espresso" } }

canonicalizes to exactly:

    {"amount":"15000000","item":{"slug":"espresso"},"rail":"hedera"}

and the hash is the SHA-256 of those bytes.

## What this proves, and what it does not

- **HCS proves integrity, not truth.** A ledger that files a wrong receipt and
  anchors it has anchored a wrong receipt, immutably. This narrows what you have
  to trust; it does not eliminate it.
- **The budget guard is advisory for `npm run buy`, and preventive for
  `decideAndBuy()`.** The customer runs the agent, so a direct call to
  `buyResource()` can be refused and used anyway — the ledger only records
  the refusal. `decideAndBuy()` (`scripts/decide-and-buy.ts`) is stricter: it
  anchors the spend decision to HCS *before* paying, and settles nothing
  unless that anchor reaches consensus with an approved verdict — a decline
  is anchored with the same rigor as an approval, not just recorded after
  the fact.
- **Anchoring is best-effort.** If HCS is unreachable the purchase still
  completes and the receipt is still filed. An unanchored receipt is worth more
  than a lost one, and it is visibly unanchored — the correct failure mode.
- **The topic alone tells you nothing.** Only hashes are published. That is a
  privacy choice, and its cost is that an anchor is meaningless without the
  receipt it fingerprints.

## Prior work

Two pieces predate this event and are disclosed as prior work.

**payment-rails-lab** was built for the NandaTown hackathon: a rail abstraction
with two working rails (x402 and MPP), the buyer composition, a funding seam,
the receipt contract, a spend cap, a budget guard and their tests.

**askReceipts** is our own hosted receipt ledger, reached over an authenticated
MCP endpoint. It is consumed as a service, not extended, and no part of it is
modified here. Anchoring runs entirely agent-side: the agent files a receipt,
reads it back, hashes it, and submits the hash to HCS. askReceipts never touches
Hedera and does not know anchoring exists.

Everything in this repository is new, open source, and written during the event.

## Licence

MIT — see [LICENSE](LICENSE).
