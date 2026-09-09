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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    !record.matched.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).ruleId === "string" &&
        typeof (entry as Record<string, unknown>).humanSummary === "string",
    ) ||
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

      // callTool()'s declared return type is a union with the legacy
      // CompatibilityCallToolResult shape (toolResult: unknown, plus an
      // index signature), which widens property access like
      // result.content to `unknown`. askReceipts' check_budget returns the
      // modern CallToolResult shape (content/isError/structuredContent),
      // confirmed live, so this narrows back to that verified real shape.
      const result = (await client.callTool({
        name: CHECK_BUDGET_TOOL,
        arguments: {
          amount: purchase.amount,
          currency: purchase.currency,
          merchant: purchase.merchant,
          description: purchase.description,
        },
      })) as CallToolResult;

      if (result.isError) {
        throw new Error(`check_budget reported a tool error: ${JSON.stringify(result.content)}`);
      }

      const content = Array.isArray(result.content) ? result.content : [];
      const [first] = content;
      if (!first || first.type !== "text") {
        throw new Error(
          `check_budget returned no text content block: ${JSON.stringify(result.content)}`,
        );
      }

      return mapResult(parseCheckBudgetResult(first.text));
    } finally {
      // A close() failure here must never mask a more useful error thrown
      // above (e.g. a network failure) by replacing it.
      await client.close().catch(() => {});
    }
  };
}
