---
name: buying-from-this-store
description: Use when an agent is about to spend money against this project's x402 store — buying an item, checking a budget, or anchoring a spend decision on hedera:testnet.
---

# Buying from this store

Every purchase here is authorised before it is paid for, and the authorisation
is published to Hedera Consensus Service **before** the money moves.

That ordering is the product. A justification written after a payment can be
shaped to fit it; one timestamped by consensus before the settlement exists
cannot. So the rule is not a style preference:

> **Never pay for anything you have not already anchored.**

## Before you can buy

Three things, and the first is the one people miss.

**1. askReceipts, over MCP.** The budget check and the receipt filing are MCP
tool calls — `check_budget` and `save_receipt`. Without that connection there is
no verdict to anchor, and **you must not buy.** Point an MCP client at
`https://www.askreceipts.com/api/mcp` with an agent key as a Bearer token.

Check it before anything else: call `ping`. If it is not connected, say exactly
that and stop —

> askReceipts is not connected, so I cannot check a budget. I will not buy
> without an authorisation to anchor.

Do not substitute your own judgement for the budget check. An agent that decides
for itself whether it may spend is the thing this project exists to prevent.

**2. A funded Hedera testnet account.** Free from
[portal.hedera.com](https://portal.hedera.com) — use a throwaway. Put the account
id and its DER private key in `.env` as `HEDERA_OPERATOR_ID` and
`HEDERA_OPERATOR_KEY`. This signs from a raw key, so testnet is enforced at
startup rather than documented.

**3. Node 24 and `npm ci`.** The repo runs TypeScript directly with no build
step. An older Node fails with `ERR_UNKNOWN_FILE_EXTENSION` — switch Node rather
than adding a loader, and use `npm ci` so nothing resolves a new version.

## The sequence

```
1. check the budget          askReceipts check_budget
2. quote the resource        GET the 402 challenge — real amount, real payee
3. anchor the decision       submit the hash to HCS, await the consensus receipt
4. only then, pay            settle against the SAME quote that was anchored
5. file the receipt          so the next agent's budget check sees the spend
```

```bash
npm run buy -- espresso --agent <name> --verdict approved --rule <ruleId>
```

That is the whole of it. `scripts/buy.ts` calls `decideAndBuy()`, which
implements 1–4; you pass the verdict you got from `check_budget`, and file the
receipt it prints. With `ASKRECEIPTS_AGENT_KEY` set it checks and files itself
instead, for a run with no agent in the loop — and in that case `--verdict`
is ignored (this repo's own `.env` sets that variable, so running the
command above here will always take that path; unset it locally to exercise
the caller-supplied one shown above).

`decideAndBuy()` has no branch that reaches a payment without a confirmed
anchor: a failed anchor returns `anchor_failed`, a non-approved verdict returns
`declined`, and both return before the payment is reachable.

**A refusal is anchored with the same rigour as an approval.** It is not an
error path — it is the outcome this project exists to make provable, because a
refusal leaves no other trace anywhere. Nothing moved, so there is no
transaction to point at.

## What not to use

**Any command that calls `buyResource()` directly bypasses the gate.** It pays
with no budget check and no anchor. That command is `npm run buy:raw` — named
so on purpose, not merely by convention: the rule keys on the behaviour, not
the name, and `:raw` is there so nobody reaches for it by habit expecting the
gate to still apply.

That command exists to exercise the store and the x402 rail in isolation, with
no askReceipts credential. Use it for debugging the payment layer. Never use it
for a purchase anyone will later want to verify.

## Verifying afterwards

Both halves are public and need no credentials:

```bash
npm run verify -- --receipt ./receipt.json
curl https://testnet.mirrornode.hedera.com/api/v1/topics/<topicId>/messages
```

The topic message is `{"v":1,"h":"<sha256>"}` and nothing else — no amounts, no
merchants. Hash the decision yourself and compare. To check the ordering, read
both consensus timestamps from the mirror node: the anchor's must be earlier
than the settlement's.

## Environment

`HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` are required, testnet only —
`assertTestnet()` refuses anything else at startup, and the buyer re-checks the
network named in the 402 challenge before signing. `HCS_TOPIC_ID` is optional;
without it a fresh topic is created, with its submit key set to the operator's
own key so only that agent can ever anchor there.

## Common mistakes

- **Paying first and anchoring after.** Backwards, and it destroys the claim —
  the anchor then proves only that you wrote something down later.
- **Anchoring a cached menu price.** Anchor the amount from the live 402
  challenge, and settle against that same quote.
- **Treating a decline as a failure to work around.** Report it and stop.
- **Skipping the receipt.** The budget cannot deplete if nothing is filed, so
  the next agent will be told it may spend money that is already gone.
