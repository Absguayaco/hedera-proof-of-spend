# Manual buy from the store

**Date:** 2026-09-07
**Status:** implemented

## Why

`packages/buyer` is the thin x402 client this project's buying agent uses, but
its core function — actually paying for something — is a stub:
`buyResource()` in `packages/buyer/src/index.ts` and both functions in
`packages/buyer/src/settlement.ts` throw `"not implemented"`. There is
currently no way to exercise a real purchase against the store by hand.

`scripts/e2e.ts` (the full seven-step demo: budget check, buy, file, anchor,
verify, HashScan, cross-rail total) is a separate, larger piece of work with
its own dependencies (askReceipts credentials, HCS topic setup). This project
is scoped to just the buy step — step 2 of that walkthrough — made runnable on
its own, so a real purchase against the store can be verified before the rest
of the pipeline exists.

## Scope

In scope:
- Implement `buyResource()` (`packages/buyer/src/index.ts`).
- Implement `parseSettlement()` and `hashscanUrl()` (`packages/buyer/src/settlement.ts`).
- A runnable CLI (`packages/buyer/src/cli.ts`) that performs one purchase
  against the store — the hosted deployment by default, or a locally-run one
  via `STORE_URL` — and prints the result.

Out of scope (left for the e2e script later):
- Budget check (`check_budget`).
- Filing the receipt to askReceipts.
- HCS anchoring and verification.
- Cross-rail spend total.

## Components

### `packages/buyer/src/settlement.ts`

- `parseSettlement(raw: string): HederaSettlement` — match `raw` against the
  existing `TX_ID` regex (`^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$`). Throw
  `Error` on no match (message must include the offending value, per this
  repo's existing error-message convention). On match, return
  `{ transactionId: raw, feePayer: match[1], seconds: Number(match[2]), nanos: Number(match[3]) }`.

- `hashscanUrl(settlement: HederaSettlement): string` — return
  `` `https://hashscan.io/testnet/tx/${settlement.transactionId}` ``.
  Confirmed live in a browser against a real testnet transaction: HashScan
  accepts the full, unencoded `account@seconds.nanos` transaction id directly
  at `/testnet/tx/<id>` (it client-side-redirects to a `/transaction/<timestamp>`
  URL that omits the account id, but the `/tx/<full-id>` link works and is the
  one worth publishing since it round-trips from `settlement.transactionId`
  with no extra parsing).

### `packages/buyer/src/index.ts`

Implement `buyResource(request: BuyRequest): Promise<BuyResult>` as an
explicit, manually-orchestrated sequence — not `wrapFetchWithPayment` — so
that `assertChallengeNetwork()` (already written and tested in `guard.ts`)
is what actually fires, with its specific message, when the store quotes an
unexpected network. `wrapFetchWithPayment` would instead surface a generic
"no scheme registered" failure from `@x402/core` on that path, which throws
away the guard's whole reason for existing as a separate, tested unit.

1. `GET request.url` with plain `fetch`. Expect a 402.
2. Decode the 402 via `x402HTTPClient.getPaymentRequiredResponse(...)` to get
   the quoted payment requirements.
3. Select the `exact` / `hedera:testnet` entry from `accepts` (the store only
   ever quotes one).
4. `assertChallengeNetwork(quoted.network)` — before any signer or key
   material is touched.
5. Build a Hedera signer from `request.operatorId` / `request.operatorKey`
   via `createClientHederaSigner`, register it on a fresh `x402Client` for
   `hedera:testnet` with `ExactHederaScheme`, and create the payment payload.
6. Encode the payload as headers and retry the `GET` with them attached.
7. Decode the settlement via `x402HTTPClient.getPaymentSettleResponse(...)`.
   If `success` is `false`, throw an `Error` carrying the facilitator's
   `errorReason` / `errorMessage`.
8. `parseSettlement(settleResponse.transaction)`. Read `amountTinybar` off
   the quoted requirement's `amount` field (`BigInt(...)`) — the wire-level
   `PaymentRequirements` type is flat (`{ scheme, network, asset, amount,
   payTo, maxTimeoutSeconds, extra }`); the nested `price: { asset, amount }`
   shape only exists in `RouteConfig`, the store's own input to route
   construction, and never appears in what the buyer decodes off the 402.
   Parse the response body as the returned resource.
9. Return `{ body, amountTinybar, settlement }`.

### `packages/buyer/src/cli.ts` (new)

Mirrors the shape of `packages/verifier/src/cli.ts`.

- Invocation: `npm run buy -- [slug]`. `slug` is optional and defaults to
  `espresso` (the cheapest item, so a bare `npm run buy` always works against
  a freshly-started store).
- Target defaults to the hosted store
  (`https://hedera-proof-of-spend-store.vercel.app`, matching `.env.example`'s
  documented `STORE_URL` default) and reads `STORE_URL` as an override — so
  `npm run buy` needs no local setup beyond testnet credentials, the same way
  `npm run verify` needs none. Set `STORE_URL=http://localhost:8402` to buy
  against a locally-run store instead.
- Reads `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` from `process.env`,
  required, same convention as the rest of the repo (fail loudly, name the
  missing variable, point at `.env.example`).
- Calls `buyResource`, then prints:
  - the item bought and its price in HBAR (tinybar → HBAR formatted locally
    in the CLI with integer arithmetic, the same technique
    `packages/store/src/menu.ts#formatHbar` uses — not imported from the
    store package, since the buyer has no dependency on the store),
  - the transaction id,
  - the HashScan link (`hashscanUrl`).
- `main().catch((error) => { console.error(...); process.exitCode = 1; })`,
  same as `verifier/src/cli.ts`.
- Add `"buy": "node packages/buyer/src/cli.ts"` to the root `package.json`
  scripts, next to the existing `"verify"` entry.

## Data flow

```
you: npm run buy -- espresso   (needs HEDERA_OPERATOR_ID + HEDERA_OPERATOR_KEY)
                                (optionally STORE_URL, to target a local store instead)

  cli
   -> buyResource({ url: <storeUrl>/buy/espresso, operatorId, operatorKey })
        -> GET (402)
        -> assertChallengeNetwork(quoted.network)
        -> sign + pay
        -> GET retry (200)
        -> parseSettlement + hashscanUrl
   -> print result
```

## Error handling

Every failure mode throws a plain `Error` with an actionable, specific
message: the network guard's existing messages, a malformed-settlement
message naming the offending value, the facilitator's own `errorReason` /
`errorMessage` on a failed settlement, and Node's own `fetch` error if the
store isn't reachable. `main().catch` in the CLI turns any of these into a
single `console.error` line and `process.exitCode = 1` — no raw stack traces
for expected failures, matching `verifier/src/cli.ts`.

## Testing

Following the existing pattern (`guard.test.ts` — pure functions, no network):

- `packages/buyer/src/settlement.test.ts`:
  - `parseSettlement`: valid id parses correctly; malformed id (missing `@`,
    non-numeric parts, extra segments) throws and names the offending value.
  - `hashscanUrl`: builds the exact expected string from a known settlement.
- `packages/buyer/src/index.test.ts`: `buyResource` with `fetch` mocked
  (402 then 200), covering:
  - the happy path end to end,
  - the network guard actually firing (and no signer/payment being
    constructed) when the 402 quotes a network other than `hedera:testnet`,
  - a facilitator `success: false` response surfacing its `errorReason`.
  No live-network tests, consistent with the rest of the suite.

## Out of scope / explicitly deferred

- Receipt filing to askReceipts.
- HCS anchoring, verification, HashScan cross-check as an automated step.
- Cross-rail spend total.
