# CheckBudget Live Implementation (askReceipts `check_budget`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

`scripts/decide-and-buy.ts` anchors a spend decision before paying, but its `CheckBudget` contract is explicitly a placeholder — its own doc comment says "nothing in this repo or its history defines that tool's actual request/response schema, and the live endpoint requires OAuth this project has no credential for." That sentence is now false. During a live check of the audit-fixes work, the real askReceipts `check_budget` MCP tool turned out to be reachable, and its full wire protocol was verified directly against the real server (not assumed): the auth is a Bearer token (Clerk-issued, not OAuth), the transport is MCP Streamable HTTP, and the tool's actual decision payload — `{decision, considered, enforcing, matched, notEvaluated}` — is materially different from the placeholder's binary `{verdict: "approved"|"declined"}` shape (four decision values, not two, plus signal like `enforcing: 0` the binary model can't express). No adapter between the two exists anywhere in the repo. This plan builds that adapter: a real, tested `CheckBudget` implementation, independently importable and verifiable, without touching the (separately much larger, unimplemented) `scripts/e2e.ts` or wiring it into `decideAndBuy()`'s defaults — that remains a human decision for later.

**Goal:** Build a real, live, independently-testable implementation of the `CheckBudget` contract (`scripts/decide-and-buy.ts`) that calls askReceipts' actual `check_budget` MCP tool over the Streamable HTTP transport, and correct one now-false sentence in `CheckBudget`'s doc comment.

**Architecture:** One new sibling module, `scripts/check-budget-live.ts`, exporting a factory `createLiveCheckBudget(config, describePurchase, fetchImpl?)` that returns a `CheckBudget`-typed closure. Internally it drives `@modelcontextprotocol/sdk`'s `Client` over `StreamableHTTPClientTransport` (Bearer-token auth via `requestInit`, fake-`fetch` injectable via the transport's own `fetch` option — the same DI seam `packages/buyer/src/index.ts` already uses for `fetch`), parses the tool's JSON-encoded-string decision payload out of `result.content[0].text`, and maps it to `BudgetCheckResponse` per a fixed, fail-closed policy. Transport/parse failures throw (matching `decideAndBuy`'s existing `checkBudget()`-failure handling); legitimate decision values from a reachable server never throw, only map to `approved`/`declined`.

**Tech Stack:** TypeScript (no build step), `@modelcontextprotocol/sdk@1.30.0` (`Client`, `StreamableHTTPClientTransport`), Vitest, Node's built-in `fetch`/`Response`.

**Design note — deviation from an illustrative two-argument factory:** `BudgetCheckRequest` (`scripts/decide-and-buy.ts`) is exactly `{ agent, resource }` — it carries no price at all. `check_budget`'s real `inputSchema` requires `amount` (a number > 0) and `currency` (an ISO code). There is no honest way to synthesize a real `amount` from `{agent, resource}` alone without inventing pricing logic that doesn't belong in this module (e.g. re-fetching the store's 402 challenge and converting HBAR to a fiat ISO code — a decision-gate concern, not a "call this MCP tool correctly" concern, and explicitly out of scope). Rather than guessing a business rule nobody asked for, that decision is pushed to whoever eventually wires this module up for real, via an injected pure function — mirroring this repo's own established DI convention for exactly this kind of "supply the domain logic, we own the plumbing" split (`fetchImpl` here and in `packages/buyer/src/index.ts`; `anchorReceiptImpl`/`buyResourceImpl` in `decide-and-buy.ts`).

## Global Constraints

- `.ts` extensions on all of THIS repo's own relative imports (e.g. `./decide-and-buy.ts`).
- SDK subpath imports use literal `.js` (e.g. `@modelcontextprotocol/sdk/client/index.js`) — required by the SDK's own `package.json` `exports` map, unrelated to this repo's own `.ts`-import convention.
- No build step; Node >= 24; test runner is Vitest (`vitest run` / `npm test`); test files are file-adjacent `*.test.ts`.
- Config (`url`, `agentKey`) is passed as an explicit parameter object — never read from `process.env` inside this module.
- Never write the real live agent-key value anywhere in any file this plan creates — tests use a fake key string and a fake `fetch`, never the real network.
- Commit messages: `feat: <summary>` for the new capability, `docs: <summary>` for the doc-comment fix (this repo's own prior `scripts/`-level commit, `feat: anchor-before-pay decision gate (decideAndBuy)`, is unscoped — this module lives in `scripts/` too, so it follows the same unscoped form).
- Run `npm run typecheck` and `npm test` (full suite) at the end of every task.
- Do not modify `scripts/e2e.ts`, `packages/buyer`, `packages/anchor`, or `packages/verifier`.
- Do not add a default parameter wiring this module into `decideAndBuy()`.
- Do not add a CLI entry point.
- Do not hardcode a demo-token default.

## What was verified live before this plan (treat as ground truth)

- **Endpoint & transport:** `POST https://www.askreceipts.com/api/mcp`, MCP Streamable HTTP (JSON-RPC 2.0, SSE-formatted response: `event: message\ndata: {...}\n\n`).
- **Auth:** `Authorization: Bearer <token>` — confirmed server-side (a bad token gets `401` with `WWW-Authenticate: Bearer error="invalid_token"` and a Clerk JWT-validation error; a real agent key gets `200`).
- **`tools/list` confirms the raw tool name is `check_budget`**, `inputSchema` requiring `amount` (number, `exclusiveMinimum: 0`) and `currency` (string), with optional `merchant`/`description`.
- **A real `tools/call` against `check_budget` was made; its response shape confirmed:** the decision payload is not structured JSON-RPC content — it's a JSON-encoded **string** inside `result.content[0].text` (the tool declares no `outputSchema`, so the SDK never populates `structuredContent`), e.g. `{"decision":"allow","considered":0,"enforcing":0,"matched":[],"notEvaluated":[]}`. A separate call returned a richer example: `{"decision":"allow","considered":1,"enforcing":0,"matched":[],"notEvaluated":[{"ruleId":"k17arpgd0c511sg0ewhjvd1b358d1pwb","humanSummary":"Alert me when I spend over $100 on restaurants in a calendar month","why":"category is assigned after the receipt is processed"}]}`.
- **SDK usage confirmed correct against the actually-installed package** (`@modelcontextprotocol/sdk@1.30.0`, already a root dependency, currently unused anywhere in this repo's source):
  - `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` — the literal `.js` suffix is required by the SDK's own `exports` map (`"./*"` → `"./dist/esm/*"` verbatim; no extensionless entry for this subpath).
  - `StreamableHTTPClientTransportOptions` takes `requestInit?: RequestInit` (for the `Authorization` header) and `fetch?: FetchLike` (a full custom-fetch injection point — the testability seam).
  - `client.connect(transport)` automatically drives the `initialize` + `notifications/initialized` handshake.
  - The transport also attempts an optional priming `GET` (an SSE listen stream) — confirmed directly in `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`: a `405` response to that GET is explicitly treated as expected, non-error ("This is an expected case that should not trigger an error"), so a fake `fetch` must handle a bare `GET` by returning `405` rather than erroring.
  - `Client.callTool({name, arguments}, resultSchema?, options?)` returns `{content, structuredContent?, isError?, ...}`; `close(): Promise<void>` is inherited from the SDK's `Protocol` base class.

## Response-mapping policy (fixed; build exactly this)

- `decision: "allow"`, `enforcing > 0` → `{ verdict: "approved" }`.
- `decision: "allow"`, `enforcing === 0` → still `{ verdict: "approved" }`, but with `reason` explaining nothing actually enforced the check (nothing was verified within budget, just not blocked).
- `decision: "refuse"` → `{ verdict: "declined", budgetRuleId: matched[0]?.ruleId, reason: matched[0]?.humanSummary ?? <fallback> }`.
- `decision: "warn"` → `{ verdict: "declined", reason: "...no human to ask..." }`. `decideAndBuy()` has no interactive human-in-the-loop path, so "ask the user before buying" can't be honored — fails closed.
- `decision: "error"` → `{ verdict: "declined", reason: "...decision: error..." }`, per the tool's own "treat as unknown, not approval" guidance.
- Any other/unrecognized `decision` value → `{ verdict: "declined", reason: "...unrecognized decision..." }`. This is defensive against a future server change; a legitimate business-logic response from a reachable server never throws, only maps to declined.
- **Transport/parse failures throw, they never map to "declined":** a non-2xx response, `result.isError === true`, a missing/non-text content block, or unparseable `content[0].text` JSON all `throw new Error(...)`. This matches `decideAndBuy()`'s existing handling — it already wraps its `checkBudget()` call in try/catch and treats a throw as "refuse to buy, nothing anchored, nothing bought," which is the correct behavior for "the check itself failed," distinct from "the check succeeded and said no."

---

## Task 1: `scripts/check-budget-live.ts` — the real `check_budget` client

**Files:**
- Create: `scripts/check-budget-live.ts`
- Test: `scripts/check-budget-live.test.ts`

**Interfaces:**
- Consumes: `BudgetCheckRequest`, `BudgetCheckResponse`, `CheckBudget` (all `import type` from `./decide-and-buy.ts`, unchanged); `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`.
- Produces (for any later task/human wiring this up): `LiveCheckBudgetConfig { url, agentKey }`, `CheckBudgetPurchase { amount, currency, merchant?, description? }`, `DescribePurchase = (request: BudgetCheckRequest) => CheckBudgetPurchase`, `createLiveCheckBudget(config: LiveCheckBudgetConfig, describePurchase: DescribePurchase, fetchImpl?: typeof fetch): CheckBudget`.

- [ ] **Step 1: Write the failing test file**

Create `scripts/check-budget-live.test.ts`:

```ts
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
          ruleId: "k17arpgd0c511sg0ewhjvd1b358d1pwb",
          humanSummary: "Alert me when I spend over $100 on restaurants in a calendar month",
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
    expect(result.budgetRuleId).toBe("k17arpgd0c511sg0ewhjvd1b358d1pwb");
    expect(result.reason).toBe("Alert me when I spend over $100 on restaurants in a calendar month");
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

  it("sends the configured agent key as a Bearer Authorization header", async () => {
    let sawAuthHeader: string | null = null;
    const { fetchImpl } = fakeAskReceipts({
      decision: "allow",
      considered: 0,
      enforcing: 0,
      matched: [],
      notEvaluated: [],
    });
    const spyingFetch = (async (input: unknown, init?: RequestInit) => {
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
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run scripts/check-budget-live.test.ts`
Expected: FAIL — `scripts/check-budget-live.ts` does not exist, so both `import type { DescribePurchase } from "./check-budget-live.ts"` and `import { createLiveCheckBudget } from "./check-budget-live.ts"` fail to resolve (Vite/Vitest module-resolution error, e.g. `Failed to resolve import "./check-budget-live.ts"`).

- [ ] **Step 3: Write the implementation**

Create `scripts/check-budget-live.ts`:

```ts
/**
 * A real, live implementation of CheckBudget (see decide-and-buy.ts) that
 * calls askReceipts' actual check_budget MCP tool over the Streamable HTTP
 * transport — replacing decide-and-buy.ts's placeholder guess with the
 * confirmed real wire format.
 *
 * Verified live against https://www.askreceipts.com/api/mcp: auth is a
 * Bearer token (Clerk-issued, format ar_agent_live_... or
 * ar_agent_demo_... for the public demo variant — NOT OAuth, despite what
 * decide-and-buy.ts's CheckBudget doc comment used to say), and the tool's
 * decision payload is not structured JSON-RPC content — it is a
 * JSON-encoded STRING inside result.content[0].text, which this module
 * parses. The tool declares no outputSchema, so the SDK's
 * Client.callTool() never populates structuredContent for it.
 *
 * BudgetCheckRequest ({agent, resource}) — decide-and-buy.ts's own
 * "minimal guess at a generic shape" — carries no price, but check_budget's
 * amount is required and must be > 0. Rather than inventing pricing logic
 * here (re-fetching the store's 402 challenge, converting HBAR to a fiat
 * ISO code — a decision-gate concern, not this module's job), that
 * decision is pushed to whoever wires this module up for real, via an
 * injected pure function: DescribePurchase. This mirrors this repo's other
 * injected collaborators (fetchImpl here and in packages/buyer,
 * anchorReceiptImpl/buyResourceImpl in decide-and-buy.ts) rather than
 * guessing.
 *
 * This module is deliberately NOT wired into decideAndBuy()'s default
 * parameters or into scripts/e2e.ts — see scripts/decide-and-buy.ts's
 * CheckBudget doc comment. A human decides that wiring later.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BudgetCheckRequest, BudgetCheckResponse, CheckBudget } from "./decide-and-buy.ts";

const CLIENT_INFO = { name: "hedera-proof-of-spend", version: "0.1.0" };
const CHECK_BUDGET_TOOL = "check_budget";

export interface LiveCheckBudgetConfig {
  /** The askReceipts MCP endpoint, e.g. https://www.askreceipts.com/api/mcp */
  readonly url: string;
  /** Bearer token for the Authorization header (a Clerk-issued agent key). */
  readonly agentKey: string;
}

/** What askReceipts' check_budget tool needs to price a check. */
export interface CheckBudgetPurchase {
  /** Purchase amount, e.g. 4.25. Must be > 0. */
  readonly amount: number;
  /** ISO currency code, e.g. "USD". */
  readonly currency: string;
  readonly merchant?: string;
  readonly description?: string;
}

/**
 * Derives the purchase check_budget needs to price a check from the
 * placeholder BudgetCheckRequest this module is handed. See this file's top
 * doc comment for why this is an injected function rather than logic
 * living here.
 */
export type DescribePurchase = (request: BudgetCheckRequest) => CheckBudgetPurchase;

/** One entry of check_budget's `matched` array: a rule that fired. */
interface RealCheckBudgetMatch {
  readonly ruleId: string;
  readonly humanSummary: string;
  readonly [key: string]: unknown;
}

/** One entry of check_budget's `notEvaluated` array: a rule not yet checkable. */
interface RealCheckBudgetNotEvaluated {
  readonly ruleId: string;
  readonly humanSummary: string;
  readonly why: string;
}

/**
 * The decision payload check_budget JSON-encodes into result.content[0].text.
 * decision is typed narrow per what's been verified live, but is read off
 * an untrusted JSON.parse — mapResult()'s `default` case exists because a
 * real runtime value is not actually guaranteed to be one of these four.
 */
interface RealCheckBudgetResult {
  readonly decision: "allow" | "refuse" | "warn" | "error";
  readonly considered: number;
  readonly enforcing: number;
  readonly matched: RealCheckBudgetMatch[];
  readonly notEvaluated: RealCheckBudgetNotEvaluated[];
}

function parseCheckBudgetResult(text: string): RealCheckBudgetResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `check_budget's content[0].text is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }): ${text}`,
    );
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.decision !== "string" ||
    typeof record.considered !== "number" ||
    typeof record.enforcing !== "number" ||
    !Array.isArray(record.matched) ||
    !Array.isArray(record.notEvaluated)
  ) {
    throw new Error(
      `check_budget's content[0].text is missing decision/considered/enforcing/matched/notEvaluated: ${text}`,
    );
  }
  return record as unknown as RealCheckBudgetResult;
}

/**
 * Maps check_budget's real decision to decideAndBuy()'s BudgetCheckResponse.
 * "warn" and "error" both fail closed to "declined": decideAndBuy() has no
 * interactive human-in-the-loop path — it's an unattended decision gate —
 * so "ask the user before buying" ("warn") cannot be honored, and the
 * tool's own description says to treat "error" as unknown, NOT approval.
 * This matches decideAndBuy()'s own fail-closed philosophy: anything that
 * isn't exactly "approved" is treated as a refusal, never the reverse.
 */
function mapResult(result: RealCheckBudgetResult): BudgetCheckResponse {
  switch (result.decision) {
    case "allow": {
      if (result.enforcing === 0) {
        return {
          verdict: "approved",
          reason:
            `askReceipts allowed this purchase, but no budget rule could actually enforce it ` +
            `(considered: ${result.considered}, enforcing: ${result.enforcing}) — this is not ` +
            `a verified-within-budget confirmation.`,
        };
      }
      return { verdict: "approved" };
    }
    case "refuse": {
      const [first] = result.matched;
      return {
        verdict: "declined",
        budgetRuleId: first?.ruleId,
        reason:
          first?.humanSummary ??
          "askReceipts refused this purchase against a budget rule, with no further detail.",
      };
    }
    case "warn":
      return {
        verdict: "declined",
        reason:
          "askReceipts wants to warn the user before this purchase, but decideAndBuy() has no " +
          "human to ask, so this fails closed.",
      };
    case "error":
      return {
        verdict: "declined",
        reason: "askReceipts could not check this purchase against any budget rule (decision: error).",
      };
    default:
      // Defensive: a future server change adding a new decision value. This
      // is a legitimate business-logic response from a reachable server,
      // not a transport failure, so it fails closed rather than throwing.
      return {
        verdict: "declined",
        reason: `askReceipts returned an unrecognized decision "${String(result.decision)}".`,
      };
  }
}

/**
 * Builds a CheckBudget that calls askReceipts' real check_budget MCP tool.
 *
 * config is never read from process.env — it's an explicit parameter, same
 * as every other core function in this repo. fetchImpl defaults to the
 * global fetch and exists so tests can inject a fake HTTP layer without
 * touching globalThis, same as packages/buyer/src/index.ts's buyResource().
 */
export function createLiveCheckBudget(
  config: LiveCheckBudgetConfig,
  describePurchase: DescribePurchase,
  fetchImpl: typeof fetch = fetch,
): CheckBudget {
  return async (request: BudgetCheckRequest): Promise<BudgetCheckResponse> => {
    const purchase = describePurchase(request);
    if (!(purchase.amount > 0)) {
      throw new Error(
        `check_budget requires a positive amount, got ${purchase.amount} for ${request.resource}`,
      );
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { Authorization: `Bearer ${config.agentKey}` } },
      fetch: fetchImpl,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });

    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: CHECK_BUDGET_TOOL,
        arguments: {
          amount: purchase.amount,
          currency: purchase.currency,
          merchant: purchase.merchant,
          description: purchase.description,
        },
      });

      if (result.isError) {
        throw new Error(`check_budget reported a tool error: ${JSON.stringify(result.content)}`);
      }

      const [first] = result.content;
      if (!first || first.type !== "text") {
        throw new Error(
          `check_budget returned no text content block: ${JSON.stringify(result.content)}`,
        );
      }

      return mapResult(parseCheckBudgetResult(first.text));
    } finally {
      await client.close();
    }
  };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run scripts/check-budget-live.test.ts`
Expected: PASS — 12 tests passed.

- [ ] **Step 5: Run the full verification suite**

Run: `npm run typecheck`
Expected: no output, exit code 0 (matches the clean baseline this plan started from).

Run: `npm test`
Expected: PASS — 18 test files, 249 tests passed (the pre-existing 17 files / 237 tests, plus this task's 1 file / 12 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/check-budget-live.ts scripts/check-budget-live.test.ts
git commit -m "feat: a real, tested CheckBudget backed by askReceipts' live check_budget MCP tool"
```

---

## Task 2: Correct the stale OAuth claim in `CheckBudget`'s doc comment

**Files:**
- Modify: `scripts/decide-and-buy.ts:39-47`

**Interfaces:**
- Consumes: nothing new (doc-comment-only change).
- Produces: nothing new — `BudgetCheckRequest`, `BudgetCheckResponse`, `CheckBudget`, and `decideAndBuy()`'s signature are all byte-for-byte unchanged; only prose changes.

- [ ] **Step 1: Confirm the stale sentence is present (RED)**

Run: `grep -n "requires OAuth this project" scripts/decide-and-buy.ts`
Expected: one match, on line 42:
```
42: * request/response schema, and the live endpoint requires OAuth this project
```

- [ ] **Step 2: Replace the doc comment**

In `scripts/decide-and-buy.ts`, replace lines 39-47 (the `CheckBudget` doc comment, currently):

```ts
/**
 * PLACEHOLDER CONTRACT. Stands in for askReceipts' real check_budget MCP
 * tool. Nothing in this repo or its history defines that tool's actual
 * request/response schema, and the live endpoint requires OAuth this project
 * has no credential for. This is this module's own minimal guess at a
 * generic shape — injectable so the gating logic is fully testable now, with
 * the real wiring deferred to a later scripts/e2e.ts slice. Do not treat
 * this as ground truth.
 */
```

with:

```ts
/**
 * PLACEHOLDER CONTRACT. Stands in for askReceipts' real check_budget MCP
 * tool. Nothing in this repo or its history defines that tool's actual
 * request/response schema, and — while a real, tested client for it now
 * exists at scripts/check-budget-live.ts (Bearer-token auth, not OAuth as
 * this comment used to claim), verified live against the real server —
 * nothing in *this* file uses it yet. This is this module's own minimal
 * guess at a generic shape — injectable so the gating logic is fully
 * testable now, with the real wiring deferred to a later scripts/e2e.ts
 * slice. Do not treat this as ground truth.
 */
```

Nothing else in the file changes — `export type CheckBudget = ...` (the line right after this comment) and every other line stays exactly as-is.

- [ ] **Step 3: Confirm the correction (GREEN)**

Run: `grep -n "requires OAuth this project" scripts/decide-and-buy.ts`
Expected: no output (the false sentence is gone).

Run: `grep -n "check-budget-live.ts" scripts/decide-and-buy.ts`
Expected: one match, inside the corrected `CheckBudget` doc comment.

- [ ] **Step 4: Run the full verification suite**

Run: `npm run typecheck`
Expected: no output, exit code 0 (a comment-only change cannot affect types, but this confirms nothing else was touched).

Run: `npm test`
Expected: PASS — 18 test files, 249 tests passed (identical count to Task 1's Step 5 — this task changes no behavior).

- [ ] **Step 5: Commit**

```bash
git add scripts/decide-and-buy.ts
git commit -m "docs: CheckBudget's OAuth claim was wrong -- the live endpoint uses a Bearer token, now confirmed and implemented at scripts/check-budget-live.ts"
```

---

## What This Plan Does NOT Do

- **No CLI entry point.** `createLiveCheckBudget` is a library function only; nothing adds an `npm run` script, a `scripts/*-cli.ts`, or reads `ASKRECEIPTS_URL`/`ASKRECEIPTS_AGENT_KEY` from `process.env`. (Those two variables already exist in `.env.example`, documented for a future caller — this plan does not add code that reads them.)
- **No wiring into `decideAndBuy()`'s default parameters.** `decideAndBuy()`'s signature in `scripts/decide-and-buy.ts` is untouched except for the one doc-comment correction in Task 2; `checkBudget` remains a required, caller-supplied argument with no default.
- **No changes to `scripts/e2e.ts`.** It remains the unimplemented stub (`throw new Error("not implemented")`) it was before this plan — a separate, larger, out-of-scope task.
- **No changes to `packages/buyer`, `packages/anchor`, or `packages/verifier`.**
- **No hardcoded demo-token default.** `agentKey` is always an explicit, required field on `LiveCheckBudgetConfig` — never defaulted to `ar_agent_demo_...` or any other literal token inside this module.
- **No pricing/business logic invented for `DescribePurchase`'s real implementation.** This plan defines the `DescribePurchase` type and injects it as a required parameter; supplying a real implementation (e.g. deriving `amount`/`currency` from the store's actual 402 challenge) is left to whoever wires this module up for real.

## Verification (whole plan)

1. `npm test` — full suite passes after every task (baseline 237 + this plan's 12 new tests = 249).
2. `npm run typecheck` — clean after every task.
3. Both tasks' technical claims were independently re-verified against the actually-installed `@modelcontextprotocol/sdk` source in `node_modules` before this plan was finalized: the transport's 405-on-GET tolerance, `Client`'s `connect`/`callTool`/`close` signatures, and `scripts/decide-and-buy.ts:39-47`'s exact current text all match what this plan assumes.

### Critical Files for Implementation

- `scripts/check-budget-live.ts` (new)
- `scripts/check-budget-live.test.ts` (new)
- `scripts/decide-and-buy.ts` (doc-comment edit only)
- `packages/buyer/src/index.ts` (DI/error-voice reference pattern, not modified)
- `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js` (confirms `fetch`/`requestInit` options and the 405-GET behavior this plan's tests depend on)
