/**
 * A real, live implementation that files a settled purchase to askReceipts
 * via its real `save_receipt` MCP tool -- so a later check_budget call can
 * see accumulated spend and refuse a purchase that would put the account
 * over budget. Without this, askReceipts never learns a purchase happened,
 * and every check_budget call sees spent: 0.00 forever -- confirmed live:
 * check_budget still reported spent 0.00 two minutes after a real 0.15 HBAR
 * purchase had already settled on chain.
 *
 * Verified against askReceipts' own save_receipt tool schema: `receipt_header`
 * is a JSON STRING (not an object) of {merchant, amount, currency, timestamp,
 * payment_method, payment_intent_id, line_items} -- built here from the
 * purchase's own settled data. The tool's own description explicitly warns
 * against sending the raw MPP Payment-Receipt HTTP header verbatim: that
 * header carries only status/method/timestamp/reference, no amount, and
 * will be refused.
 *
 * CURRENCY MUST MATCH whatever the budget rule and every check_budget call
 * already use, or spend silently never counts against the rule (askReceipts
 * filters by currency, with no conversion). Callers of this module must
 * pass the SAME amount/currency already computed for check_budget -- in
 * this project that is always HBAR, from scripts/e2e.ts's
 * buildDescribePurchase(); see its wiring, and
 * .claude/skills/anchor-before-pay/SKILL.md's "Always HBAR".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLIENT_INFO = { name: "hedera-proof-of-spend", version: "0.1.0" };
const SAVE_RECEIPT_TOOL = "save_receipt";

export interface LiveSaveReceiptConfig {
  /** The askReceipts MCP endpoint, e.g. https://www.askreceipts.com/api/mcp */
  readonly url: string;
  readonly agentKey: string;
}

/** What save_receipt's receipt_header needs, per its own tool schema --
 *  mapped from the purchased resource's response, never from the raw MPP
 *  HTTP header (see this file's top doc comment). */
export interface SettledPurchase {
  readonly merchant: string;
  /** Nominal amount, in the SAME currency/rate the budget rule and every
   *  check_budget call already use -- not the real HBAR amount. */
  readonly amount: number;
  readonly currency: string;
  readonly timestamp: string; // ISO 8601
  /** The settlement's own reference -- this repo uses the Hedera
   *  transaction id, matching payment_intent_id's role for deduplication. */
  readonly paymentIntentId: string;
  readonly lineItems?: ReadonlyArray<{ description: string; amount: number }>;
}

/**
 * Builds a function that files one settled purchase to askReceipts.
 *
 * config is never read from process.env -- an explicit parameter, same as
 * every other core function in this repo. fetchImpl defaults to the global
 * fetch and exists so tests can inject a fake HTTP layer, matching
 * scripts/check-budget-live.ts's createLiveCheckBudget().
 */
export function saveReceiptLive(
  config: LiveSaveReceiptConfig,
  fetchImpl: typeof fetch = fetch,
): (purchase: SettledPurchase, purchasedBy: string) => Promise<void> {
  return async (purchase: SettledPurchase, purchasedBy: string): Promise<void> => {
    const receiptHeader = JSON.stringify({
      merchant: purchase.merchant,
      amount: purchase.amount,
      currency: purchase.currency,
      timestamp: purchase.timestamp,
      payment_method: "hedera",
      payment_intent_id: purchase.paymentIntentId,
      line_items: purchase.lineItems ?? [],
    });

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { Authorization: `Bearer ${config.agentKey}` } },
      fetch: fetchImpl,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });

    try {
      await client.connect(transport);

      const result = (await client.callTool({
        name: SAVE_RECEIPT_TOOL,
        arguments: {
          source_type: "mpp",
          receipt_header: receiptHeader,
          payment_rail: "hedera",
          purchased_by: purchasedBy,
        },
      })) as CallToolResult;

      if (result.isError) {
        // Not echoed: the response can carry budget-rule text, merchant
        // names, or amounts -- same reasoning as
        // packages/anchor/src/index.ts's "the key itself is not reported
        // here on purpose".
        throw new Error("save_receipt reported a tool error (content redacted).");
      }
    } finally {
      await client.close().catch(() => {});
    }
  };
}
