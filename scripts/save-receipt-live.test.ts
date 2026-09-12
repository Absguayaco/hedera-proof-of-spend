import { describe, expect, it } from "vitest";
import { saveReceiptLive } from "./save-receipt-live.ts";

const MCP_URL = "https://example.invalid/api/mcp";
const AGENT_KEY = "fake-agent-key";
const PURCHASE = {
  merchant: "hedera-proof-of-spend store",
  amount: 0.15,
  currency: "USD",
  timestamp: "2026-09-11T12:50:02.485Z",
  paymentIntentId: "0.0.10412992@1789130999.123456789",
  lineItems: [{ description: "Espresso", amount: 0.15 }],
};

function sseBody(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}
function sseResponse(payload: unknown): Response {
  return new Response(sseBody(payload), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function initializeResult(id: number) {
  return {
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "mcp-typescript server on vercel", version: "0.1.0" },
    },
    jsonrpc: "2.0",
    id,
  };
}
function toolCallResult(id: number, result: unknown) {
  return { result, jsonrpc: "2.0", id };
}

function fakeAskReceipts(toolResult: unknown): {
  fetchImpl: typeof fetch;
  toolCallArguments: () => unknown;
} {
  let toolCallArgs: unknown;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body)) as { method: string; id: number; params?: { arguments?: unknown } };
    if (body.method === "initialize") return sseResponse(initializeResult(body.id));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      toolCallArgs = body.params?.arguments;
      return sseResponse(toolCallResult(body.id, toolResult));
    }
    throw new Error(`unexpected method ${body.method}`);
  }) as typeof fetch;
  return { fetchImpl, toolCallArguments: () => toolCallArgs };
}

describe("saveReceiptLive", () => {
  it("calls save_receipt with source_type mpp, a JSON-STRING receipt_header, payment_rail hedera, and purchasedBy", async () => {
    const { fetchImpl, toolCallArguments } = fakeAskReceipts({ content: [{ type: "text", text: "ok" }] });
    const save = saveReceiptLive({ url: MCP_URL, agentKey: AGENT_KEY }, fetchImpl);

    await save(PURCHASE, "hedera-proof-of-spend-e2e-agent");

    const args = toolCallArguments() as Record<string, unknown>;
    expect(args.source_type).toBe("mpp");
    expect(args.payment_rail).toBe("hedera");
    expect(args.purchased_by).toBe("hedera-proof-of-spend-e2e-agent");
    expect(typeof args.receipt_header).toBe("string");
    const header = JSON.parse(args.receipt_header as string);
    expect(header).toEqual({
      merchant: PURCHASE.merchant,
      amount: PURCHASE.amount,
      currency: PURCHASE.currency,
      timestamp: PURCHASE.timestamp,
      payment_method: "hedera",
      payment_intent_id: PURCHASE.paymentIntentId,
      line_items: PURCHASE.lineItems,
    });
  });

  it("throws, without echoing the raw response, when the tool reports an error", async () => {
    const { fetchImpl } = fakeAskReceipts({ content: [{ type: "text", text: "budget rule XYZ exceeded" }], isError: true });
    const save = saveReceiptLive({ url: MCP_URL, agentKey: AGENT_KEY }, fetchImpl);

    const attempt = save(PURCHASE, "agent");
    await expect(attempt).rejects.toThrow(/tool error/);
    await attempt.catch((error: unknown) => {
      expect((error as Error).message).not.toContain("budget rule XYZ");
    });
  });

  it("sends the configured agent key as a Bearer Authorization header", async () => {
    let sawAuthHeader: string | null = null;
    const { fetchImpl } = fakeAskReceipts({ content: [{ type: "text", text: "ok" }] });
    const spyingFetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        sawAuthHeader = new Headers(init?.headers).get("authorization");
      }
      return fetchImpl(input as string, init);
    }) as typeof fetch;
    const save = saveReceiptLive({ url: MCP_URL, agentKey: AGENT_KEY }, spyingFetch);

    await save(PURCHASE, "agent");

    expect(sawAuthHeader).toBe(`Bearer ${AGENT_KEY}`);
  });
});
