/**
 * One-off setup: creates the budget rule the live decline demonstration
 * (`npm run e2e`) depends on, via askReceipts' real `create_budget` MCP
 * tool. NOT part of the demo flow itself and not one of the five components
 * -- this is account provisioning, run once by hand before a live run, the
 * same way a human would otherwise do it through askReceipts' own UI.
 *
 * Deliberately NOT in packages/buyer: that package speaks exactly one
 * rail (the Hedera x402 payment rail) and knows nothing about askReceipts;
 * this script calls a completely different external system to set ledger
 * policy, which is not a payment-rail concern at all.
 *
 * Uses the same real wire format createLiveCheckBudget() (check-budget-
 * live.ts) already verified live against https://www.askreceipts.com/api/mcp
 * for check_budget: Streamable HTTP transport, Bearer-token auth, and the
 * tool result as a text content block. create_budget's own response SHAPE
 * is not independently verified live the way check_budget's was -- this
 * prints it raw rather than assuming a specific structure, so a human can
 * read what actually came back rather than trusting a parsed guess.
 *
 * Usage:
 *   ASKRECEIPTS_AGENT_KEY=... npm run seed-budget
 *   ASKRECEIPTS_AGENT_KEY=... npm run seed-budget -- \
 *     --description "Refuse any agent purchase over $0.30." --enforcement refuse
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLIENT_INFO = { name: "hedera-proof-of-spend", version: "0.1.0" };
const CREATE_BUDGET_TOOL = "create_budget";
const DEFAULT_ASKRECEIPTS_URL = "https://www.askreceipts.com/api/mcp";

// The exact wording docs/superpowers/plans/2026-09-09-e2e-walkthrough.md's
// Prerequisite section specifies, matching (verbatim) scripts/e2e.ts's own
// MERCHANT constant ("hedera-proof-of-spend store") so askReceipts' NLU
// rule-matching is less likely to scope the rule differently than intended.
// A threshold strictly between espresso ($0.15) and cold-brew ($0.35) makes
// exactly one menu item decline and at least one reliably approve; $0.30
// sits in the middle of that gap with margin on both sides.
const DEFAULT_DESCRIPTION = "Refuse any agent purchase on the hedera-proof-of-spend store over $0.30.";
const DEFAULT_ENFORCEMENT = "refuse";
const VALID_ENFORCEMENTS = new Set(["refuse", "warn", "notify"]);

interface Args {
  readonly url: string;
  readonly agentKey: string;
  readonly description: string;
  readonly enforcement: string;
}

function requireEnv(name: string, message?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(message ?? `${name} is not set. See .env.example.`);
  }
  return value;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  let description: string | undefined;
  let enforcement: string | undefined;
  let url: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--description") description = argv[(i += 1)];
    else if (flag === "--enforcement") enforcement = argv[(i += 1)];
    else if (flag === "--url") url = argv[(i += 1)];
  }

  const resolvedEnforcement = enforcement ?? DEFAULT_ENFORCEMENT;
  if (!VALID_ENFORCEMENTS.has(resolvedEnforcement)) {
    throw new Error(
      `--enforcement must be one of refuse, warn, notify (got "${resolvedEnforcement}").`,
    );
  }

  return {
    url: (url || env.ASKRECEIPTS_URL?.trim() || DEFAULT_ASKRECEIPTS_URL).replace(/\/$/, ""),
    agentKey: requireEnv(
      "ASKRECEIPTS_AGENT_KEY",
      "ASKRECEIPTS_AGENT_KEY is not set. This creates a budget rule on whichever askReceipts " +
        "account this key authenticates as -- see .env.example.",
    ),
    description: description ?? DEFAULT_DESCRIPTION,
    enforcement: resolvedEnforcement,
  };
}

async function main(): Promise<void> {
  const { url, agentKey, description, enforcement } = parseArgs(process.argv.slice(2), process.env);

  console.log(`askReceipts: ${url}`);
  console.log(`description: ${description}`);
  console.log(`enforcement: ${enforcement}`);
  console.log("");

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${agentKey}` } },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport);

    const result = (await client.callTool({
      name: CREATE_BUDGET_TOOL,
      arguments: { description, enforcement },
    })) as CallToolResult;

    if (result.isError) {
      throw new Error(`create_budget reported a tool error: ${JSON.stringify(result.content)}`);
    }

    const content = Array.isArray(result.content) ? result.content : [];
    const [first] = content;
    if (!first || first.type !== "text") {
      throw new Error(`create_budget returned no text content block: ${JSON.stringify(result.content)}`);
    }

    // Printed raw, not parsed: unlike check_budget's decision payload
    // (verified live and typed in check-budget-live.ts), create_budget's
    // response shape isn't independently confirmed here -- read this by
    // eye and confirm it actually reports enforcement "refuse" (or
    // whatever was requested), not a guess.
    console.log("create_budget response:");
    console.log(first.text);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
