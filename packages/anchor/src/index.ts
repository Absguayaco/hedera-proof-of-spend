/**
 * Agent-side HCS anchoring.
 *
 * This runs entirely on the agent side. The receipt ledger never touches
 * Hedera and does not know anchoring exists — which is what keeps the ledger a
 * dependency rather than something this project extends.
 *
 * Anchoring is BEST-EFFORT by design. A failed anchor must never block a
 * purchase or lose a receipt: an unanchored receipt is worth more than a lost
 * one, and it is visibly unanchored, which is the correct failure mode.
 */
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { hashReceipt } from "./hash.ts";
import { createTopic, submitHash } from "./topic.ts";

export interface AnchorResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly topicId?: string;
  /** Present when ok is false. Reported, never thrown. */
  readonly error?: string;
}

/** The network-facing seam. Real HCS calls in production; a fake in tests —
 *  the same shape `fetchImpl` plays in packages/buyer, but for the Hedera SDK
 *  boundary instead of HTTP. Client construction and key parsing stay real in
 *  both, matching how buyer's tests exercise real offline signing. */
export interface HcsOps {
  readonly createTopic: (client: Client) => Promise<string>;
  readonly submitHash: (client: Client, topicId: string, hash: string) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function anchorReceipt(
  receipt: unknown,
  opts: { operatorId: string; operatorKey: string; topicId?: string },
  hcs: HcsOps = { createTopic, submitHash },
): Promise<AnchorResult> {
  let hash: string;
  try {
    hash = hashReceipt(receipt);
  } catch (error) {
    // No hash is computable at all — report it visibly rather than losing
    // the purchase's anchoring step silently.
    return { ok: false, hash: "", error: describeError(error) };
  }

  // Parsed in its own try/catch, separate from the network-facing operations
  // below, so a bad key never reaches a catch block that echoes error
  // messages back to the caller: PrivateKey.fromString's own error message
  // includes the raw input verbatim, and that input is (almost) the secret.
  let operatorKey: PrivateKey;
  try {
    operatorKey = PrivateKey.fromString(opts.operatorKey);
  } catch {
    return {
      ok: false,
      hash,
      error:
        `HEDERA_OPERATOR_KEY is not a valid Hedera private key ` +
        `(${opts.operatorKey.length} characters). See .env.example. ` +
        `The key itself is not reported here on purpose.`,
    };
  }

  // client is constructed *inside* the try below, not before it: Client.forTestnet()
  // alone already schedules the network-update timers that need closing (verified
  // empirically — a process that only calls Client.forTestnet() and never closes it
  // hangs indefinitely), and .setOperator() throws synchronously for a malformed
  // operatorId. Both must be covered by the same try/finally so (a) a bad
  // operatorId becomes {ok:false, error} rather than a rejected promise, and
  // (b) the client Client.forTestnet() already constructed still gets closed
  // even when the immediately-following .setOperator() call is what throws.
  let client: Client | undefined;
  try {
    try {
      client = Client.forTestnet();
      client.setOperator(opts.operatorId, operatorKey);
      const topicId = opts.topicId ?? (await hcs.createTopic(client));
      try {
        await hcs.submitHash(client, topicId, hash);
      } catch (error) {
        // A topic may already exist even though submission failed — report it
        // so a retry reuses it instead of creating (and leaking) a new one.
        return { ok: false, hash, topicId, error: describeError(error) };
      }
      return { ok: true, hash, topicId };
    } catch (error) {
      // Anchoring is best-effort: a failed anchor must never block a purchase.
      // The hash is still reported so the caller can retry or log it. If the
      // caller supplied a topicId, echo it back — createTopic is what failed
      // here, not the topic the caller already had. No topic id was newly
      // obtained in that case.
      return {
        ok: false,
        hash,
        ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
        error: describeError(error),
      };
    }
  } finally {
    // Client.forTestnet() schedules network-update timers that keep the
    // event loop alive until closed. client may be undefined if
    // Client.forTestnet() itself threw (not observed in practice, but
    // guarded regardless — there is nothing to close in that case).
    // Best-effort teardown: a close() failure must never override the
    // result already computed above.
    if (client) {
      try {
        client.close();
      } catch {
        // ignored on purpose
      }
    }
  }
}

export { hashReceipt, canonicalize, HASH_VERSION } from "./hash.ts";
export { createTopic, submitHash } from "./topic.ts";
export type { AnchorMessage } from "./topic.ts";
