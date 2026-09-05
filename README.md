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

## What this proves, and what it does not

- **HCS proves integrity, not truth.** A ledger that files a wrong receipt and
  anchors it has anchored a wrong receipt, immutably. This narrows what you have
  to trust; it does not eliminate it.
- **The budget guard is advisory, by construction.** The customer runs the
  buying agent, so it can ask permission, be refused, and buy anyway. What the
  ledger does is record the refusal. This observes accurately; it does not prevent.
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
