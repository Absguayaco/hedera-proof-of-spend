import { describe, expect, it } from "vitest";
import type { BudgetCheckRequest } from "./decide-and-buy.ts";
import type { DescribePurchase } from "./check-budget-live.ts";
import { createLiveCheckBudget } from "./check-budget-live.ts";

const MCP_URL = "https://example.invalid/api/mcp";
const AGENT_KEY = "fake-agent-key";
const REQUEST: BudgetCheckRequest = {
  agent: "agent-demo",
  resource: "http://localhost:8402/buy/espresso",
};

const describeEspresso: DescribePurchase = () => ({
  amount: 4.25,
  currency: "USD",
  merchant: "the store",
  description: "Flat White",
});

function sseBody(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(payload: unknown): Response {
  return new Response(sseBody(payload), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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

function toolCallResult(id: number, decision: unknown) {
  return {
    result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
    jsonrpc: "2.0",
    id,
  };
}

/**
 * Fakes the full MCP Streamable HTTP round trip createLiveCheckBudget
 * drives: a GET priming-stream attempt (declined with 405, same as a real
 * server not offering server push on GET), the initialize handshake, the
 * fire-and-forget notifications/initialized notification (202), and one
 * tools/call whose result is `decision`, JSON-encoded into content[0].text
 * exactly as askReceipts' real check_budget does.
 */
function fakeAskReceipts(decision: unknown): {
  fetchImpl: typeof fetch;
  toolCallArguments: () => unknown;
} {
  let toolCallArgs: unknown;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      id: number;
      params?: { arguments?: unknown };
    };
    if (body.method === "initialize") {
      return sseResponse(initializeResult(body.id));
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      toolCallArgs = body.params?.arguments;
      return sseResponse(toolCallResult(body.id, decision));
    }
    throw new Error(`fakeAskReceipts: unexpected JSON-RPC method "${body.method}"`);
  }) as typeof fetch;
  return { fetchImpl, toolCallArguments: () => toolCallArgs };
}

describe("createLiveCheckBudget", () => {
  it('maps decision "allow" with an enforcing rule to a plain approval', async () => {
    const { fetchImpl, toolCallArguments } = fakeAskReceipts({
      decision: "allow",
      considered: 1,
      enforcing: 1,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result).toEqual({ verdict: "approved" });
    expect(toolCallArguments()).toEqual({
      amount: 4.25,
      currency: "USD",
      merchant: "the store",
      description: "Flat White",
    });
  });

  it('maps decision "allow" with enforcing: 0 to an approval explaining nothing actually enforced it', async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "allow",
      considered: 0,
      enforcing: 0,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("approved");
    expect(result.reason).toContain("no budget rule could actually enforce it");
    expect(result.reason).toContain("considered: 0, enforcing: 0");
  });

  it('maps decision "refuse" with a matched rule to a decline carrying its ruleId and humanSummary', async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "refuse",
      considered: 1,
      enforcing: 1,
      matched: [
        {
          ruleId: "rule-restaurant-cap",
          humanSummary: "cap restaurant spending at $100/month",
        },
      ],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("declined");
    expect(result.budgetRuleId).toBe("rule-restaurant-cap");
    expect(result.reason).toBe("cap restaurant spending at $100/month");
  });

  it('maps decision "refuse" with no matched rule to a decline with a fallback reason', async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "refuse",
      considered: 1,
      enforcing: 1,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("declined");
    expect(result.budgetRuleId).toBeUndefined();
    expect(result.reason).toBe(
      "askReceipts refused this purchase against a budget rule, with no further detail.",
    );
  });

  it('maps decision "warn" to a decline, since decideAndBuy() has no human to ask', async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "warn",
      considered: 1,
      enforcing: 1,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("declined");
    expect(result.reason).toContain("no human to ask");
  });

  it('maps decision "error" to a decline per the tool\'s own "treat as unknown" guidance', async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "error",
      considered: 0,
      enforcing: 0,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("declined");
    expect(result.reason).toContain("decision: error");
  });

  it("fails closed, without throwing, on a decision value outside the known four", async () => {
    const { fetchImpl } = fakeAskReceipts({
      decision: "unknown_future_decision",
      considered: 1,
      enforcing: 1,
      matched: [],
      notEvaluated: [],
    });
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    const result = await checkBudget(REQUEST);

    expect(result.verdict).toBe("declined");
    expect(result.reason).toContain('unrecognized decision "unknown_future_decision"');
  });

  it("sends the configured agent key as a Bearer Authorization header, to the configured URL", async () => {
    let sawAuthHeader: string | null = null;
    let sawUrl: string | null = null;
    const { fetchImpl } = fakeAskReceipts({
      decision: "allow",
      considered: 0,
      enforcing: 0,
      matched: [],
      notEvaluated: [],
    });
    const spyingFetch = (async (input: unknown, init?: RequestInit) => {
      sawUrl = String(input);
      if ((init?.method ?? "GET") !== "GET") {
        sawAuthHeader = new Headers(init?.headers).get("authorization");
      }
      return fetchImpl(input as string, init);
    }) as typeof fetch;

    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      spyingFetch,
    );
    await checkBudget(REQUEST);

    expect(sawAuthHeader).toBe(`Bearer ${AGENT_KEY}`);
    expect(sawUrl).toBe(MCP_URL);
  });

  it("throws, without calling the network, when describePurchase produces a non-positive amount", async () => {
    const zeroAmount: DescribePurchase = () => ({ amount: 0, currency: "USD" });
    const fetchImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      zeroAmount,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow(/positive amount, got 0/);
  });

  it("throws on a non-2xx response from the server (a transport failure, not a decline)", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(null, { status: 405 });
      return new Response("invalid_token", { status: 401 });
    }) as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: "bad-key" },
      describeEspresso,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow();
  });

  it("throws on a content[0].text that is not valid JSON", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (body.method === "initialize") return sseResponse(initializeResult(body.id));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        return sseResponse({
          result: { content: [{ type: "text", text: "not json{{{" }] },
          jsonrpc: "2.0",
          id: body.id,
        });
      }
      throw new Error(`unexpected method ${body.method}`);
    }) as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when check_budget reports isError", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (body.method === "initialize") return sseResponse(initializeResult(body.id));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        return sseResponse({
          result: { content: [{ type: "text", text: "boom" }], isError: true },
          jsonrpc: "2.0",
          id: body.id,
        });
      }
      throw new Error(`unexpected method ${body.method}`);
    }) as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow(/tool error/);
  });

  it("throws when content is an empty array (no text content block)", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (body.method === "initialize") return sseResponse(initializeResult(body.id));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        return sseResponse({
          result: { content: [] },
          jsonrpc: "2.0",
          id: body.id,
        });
      }
      throw new Error(`unexpected method ${body.method}`);
    }) as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow(/no text content block/);
  });

  it("throws when content[0].text is valid JSON but missing required fields", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (body.method === "initialize") return sseResponse(initializeResult(body.id));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        return sseResponse({
          result: { content: [{ type: "text", text: '{"decision":"allow"}' }] },
          jsonrpc: "2.0",
          id: body.id,
        });
      }
      throw new Error(`unexpected method ${body.method}`);
    }) as typeof fetch;
    const checkBudget = createLiveCheckBudget(
      { url: MCP_URL, agentKey: AGENT_KEY },
      describeEspresso,
      fetchImpl,
    );

    await expect(checkBudget(REQUEST)).rejects.toThrow(
      /missing decision\/considered\/enforcing\/matched\/notEvaluated/,
    );
  });
});
