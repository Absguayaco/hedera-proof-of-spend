import { PrivateKey } from "@x402/hedera";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { buyResource } from "./index.ts";

const OPERATOR_ID = "0.0.99999";
const OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
const PAY_TO = "0.0.54321";
const FACILITATOR_ID = "0.0.11111";
const URL = "http://localhost:8402/buy/espresso";

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function paymentRequiredResponse(network: `${string}:${string}`): Response {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: URL },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: "0.0.0",
        amount: "15000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        // The Hedera exact scheme requires the fee payer's account id here
        // to set the transaction's TransactionId — a real store's 402
        // challenge always carries this (it's the facilitator's fee-payer
        // address; see packages/store/src/preflight.test.ts's fixtures for
        // the same field).
        extra: { feePayer: FACILITATOR_ID },
      },
    ],
  };
  return new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodeHeader(paymentRequired) },
  });
}

function settledResponse(overrides: Partial<SettleResponse> = {}): Response {
  const settleResponse: SettleResponse = {
    success: true,
    transaction: "0.0.99999@1699999999.123456789",
    network: "hedera:testnet",
    ...overrides,
  };
  return new Response(JSON.stringify({ item: { slug: "espresso" } }), {
    status: 200,
    headers: { "PAYMENT-RESPONSE": encodeHeader(settleResponse) },
  });
}

describe("buyResource", () => {
  it("buys the resource end to end against a well-behaved store", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? paymentRequiredResponse("hedera:testnet") : settledResponse();
    }) as typeof fetch;

    const result = await buyResource(
      { url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY },
      fetchImpl,
    );

    expect(result.amountTinybar).toBe(15_000_000n);
    expect(result.settlement.transactionId).toBe("0.0.99999@1699999999.123456789");
    expect(result.body).toEqual({ item: { slug: "espresso" } });
  });

  it("refuses to pay when the store quotes a network other than hedera:testnet, before any payment is created", async () => {
    const fetchImpl = (async () => paymentRequiredResponse("hedera:mainnet")) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/Refusing to pay/);
  });

  it("surfaces the facilitator's reason when settlement fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return paymentRequiredResponse("hedera:testnet");
      return settledResponse({
        success: false,
        errorReason: "insufficient_funds",
        errorMessage: "balance too low",
      });
    }) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/insufficient_funds/);
  });

  it("reports the store's status when no settlement header comes back after payment", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return paymentRequiredResponse("hedera:testnet");
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/status 500/);
  });

  it("rejects a store that does not challenge with 402", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    await expect(
      buyResource({ url: URL, operatorId: OPERATOR_ID, operatorKey: OPERATOR_KEY }, fetchImpl),
    ).rejects.toThrow(/expected 402/);
  });
});
