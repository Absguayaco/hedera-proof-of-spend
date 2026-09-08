import { hashReceipt } from "./hash.ts";

/**
 * An independent verifier.
 *
 * Takes a receipt, hashes it, queries the HCS topic, and reports one of three
 * outcomes. It depends on nothing of ours: one public Hedera SDK and node's
 * standard library. See this package's package.json — that dependency list is
 * the claim, and a workspace dependency added there would quietly void it.
 *
 * What each outcome means:
 *   match   — this is exactly what was recorded, at the time claimed
 *   missing — never anchored; may have been added to the ledger afterwards
 *   altered — a hash was anchored for this receipt id, but the receipt differs,
 *             so the record changed after the fact
 *
 * What this does NOT prove: that the receipt is true. A ledger that files a
 * wrong receipt and anchors it has anchored a wrong receipt, immutably. This
 * is tamper-evidence, not correctness.
 */
export type Outcome = "match" | "missing" | "altered";

export interface VerifyResult {
  readonly outcome: Outcome;
  /** The hash this verifier computed, independently, from the receipt. */
  readonly computedHash: string;
  /** Consensus timestamp of the anchoring message, when one was found. */
  readonly consensusTimestamp?: string;
  /** Link to the same message on HashScan, on a network neither party controls. */
  readonly hashscanUrl?: string;
}

/** Confirmed live (2026-09-08): the mirror node's public REST base URLs. Not
 *  imported from @x402/hedera on purpose — see this package's package.json:
 *  the dependency list is the claim. */
const MIRROR_NODE_URL: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

interface MirrorMessage {
  readonly message: string; // base64
  readonly consensus_timestamp: string;
}

interface MirrorMessagesPage {
  readonly messages: readonly MirrorMessage[];
  readonly links: { readonly next: string | null };
}

export async function verify(
  receipt: unknown,
  opts: { topicId: string; network?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const computedHash = hashReceipt(receipt);
  const network = opts.network ?? "testnet";
  const base = MIRROR_NODE_URL[network];
  if (!base) {
    throw new Error(`Unsupported network "${network}". Expected "testnet" or "mainnet".`);
  }

  let path: string | null = `/api/v1/topics/${opts.topicId}/messages?limit=100`;
  while (path) {
    const response = await fetchImpl(`${base}${path}`);
    if (!response.ok) {
      throw new Error(
        `Mirror node returned ${response.status} for topic ${opts.topicId}. ` +
          `Check the topic id and network.`,
      );
    }
    const parsedPage = (await response.json()) as MirrorMessagesPage;

    for (const entry of parsedPage.messages) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(entry.message, "base64").toString("utf8"));
        if (
          decoded !== null &&
          typeof decoded === "object" &&
          (decoded as { h?: unknown }).h === computedHash
        ) {
          return {
            outcome: "match",
            computedHash,
            consensusTimestamp: entry.consensus_timestamp,
            hashscanUrl: `https://hashscan.io/${network}/topic/${opts.topicId}/messages`,
          };
        }
      } catch {
        // not our JSON shape — skip rather than fail the whole scan
      }
    }

    // links.next is a relative path, not an absolute URL — confirmed live.
    path = parsedPage.links.next;
  }

  // A hash with no matching message could mean "never anchored" or "anchored
  // for a different version of this receipt, now altered" — but AnchorMessage
  // carries only {v, h}, no receipt id or other correlator (a deliberate
  // privacy choice: "the topic alone tells an observer nothing"). Without a
  // correlator those two cases are indistinguishable from a topic scan, so
  // "altered" is not reachable here; every non-match reports "missing".
  return { outcome: "missing", computedHash };
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
