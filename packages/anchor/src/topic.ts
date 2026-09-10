/**
 * HCS topic lifecycle. One topic holds every anchor for a demo account.
 */
import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Client, PublicKey } from "@hiero-ledger/sdk";
import { HASH_VERSION } from "./hash.ts";

/** The message written to the topic. Only the hash leaves the system — no
 *  amounts, no merchants, no line items, and no receipt id. A verifier finds
 *  its receipt by scanning for a matching hash, which is exactly the privacy
 *  property claimed: the topic alone tells an observer nothing. */
export interface AnchorMessage {
  readonly v: number;
  readonly h: string;
}

/** What submitHash() reports back once the submission reaches consensus.
 *  Carries the HCS topic sequence number -- the position this message holds
 *  in the topic's own ordered log -- converted from the SDK's `Long` to a
 *  decimal string (this project's numbers-travel-as-strings convention;
 *  see packages/anchor/src/hash.ts's canonicalize() rule 2, which rejects
 *  raw JS numbers outright). This is what closes Build Kit B2/B3: a
 *  structured, independently-checkable reference a filed receipt can carry
 *  back to the decision that authorized it. */
export interface SubmitHashResult {
  readonly sequenceNumber: string;
}

/** The exact bytes written to the topic. Pulled out on its own so the "only
 *  {v, h} leaves the system" claim is checkable without a network. */
export function encodeAnchorMessage(hash: string): string {
  const message: AnchorMessage = { v: HASH_VERSION, h: hash };
  return JSON.stringify(message);
}

/**
 * Creates a topic with its submit key set to `submitKey` -- once set, HCS
 * itself rejects any TopicMessageSubmitTransaction not signed by that key,
 * before it ever reaches consensus. Without this, ANY Hedera account can
 * write to the topic, and a third party's verify() can never tell "this
 * hash was published by the agent claiming it" from "this hash was
 * published by anyone" -- confirmed live against this project's own
 * pre-existing topic (0.0.10424108): its real mirror-node record shows
 * "submit_key":null.
 */
export async function createTopic(client: Client, submitKey: PublicKey): Promise<string> {
  const response = await new TopicCreateTransaction()
    .setTopicMemo("hedera-proof-of-spend anchor")
    .setSubmitKey(submitKey)
    .execute(client);
  // execute() only reports the pre-check passed; getReceipt() is what
  // observes real consensus failure (same reasoning as @x402/hedera's
  // createHederaSignAndSubmitTransaction and this repo's other Hedera calls).
  const receipt = await response.getReceipt(client);
  if (!receipt.topicId) {
    throw new Error("TopicCreateTransaction succeeded but the receipt carried no topic id.");
  }
  return receipt.topicId.toString();
}

export async function submitHash(
  client: Client,
  topicId: string,
  hash: string,
): Promise<SubmitHashResult> {
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(encodeAnchorMessage(hash))
    .execute(client);
  // getReceipt() throws ReceiptStatusError on a non-SUCCESS status — that
  // throw is what anchorReceipt()'s catch-everything contract relies on.
  const receipt = await response.getReceipt(client);
  // topicSequenceNumber is `Long | null` on the SDK's TransactionReceipt --
  // populated specifically for TopicMessageSubmitTransaction receipts. A
  // real Long is always an object (never falsy), so this is a strict
  // null/undefined check, not a truthiness check that a real sequence
  // number of 0 could ever accidentally trip.
  if (receipt.topicSequenceNumber === null || receipt.topicSequenceNumber === undefined) {
    throw new Error(
      `TopicMessageSubmitTransaction succeeded but the receipt carried no topic sequence ` +
        `number (topic ${topicId}).`,
    );
  }
  return { sequenceNumber: receipt.topicSequenceNumber.toString() };
}

// Confirmed live (this plan): the same testnet mirror-node base URL
// packages/verifier uses. packages/anchor is already testnet-only
// (Client.forTestnet(), hardcoded), so this is hardcoded too -- no network
// parameter, for the same reason.
const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

/** The one field this needs from GET /api/v1/topics/{id} -- confirmed live
 *  against a real topic: {"submit_key": null, ...} when unset, or
 *  {"submit_key": {"_type": "ECDSA_SECP256K1"|"ED25519", "key": "<hex>"},
 *  ...} when set (confirmed live against a real account's key field, same
 *  shape). `key` is lowercase hex with no "0x" prefix -- confirmed to match
 *  PublicKey.toStringRaw()'s own output format exactly. */
interface MirrorTopicInfo {
  readonly submit_key: { readonly _type: string; readonly key: string } | null;
}

/**
 * Refuses to proceed unless `topicId`'s own submit key genuinely belongs to
 * `operatorPublicKey` -- this is what makes reusing a caller-supplied topic
 * id (rather than creating a fresh one every time) safe. Called by
 * anchorReceipt() only when a topicId is supplied (never for a topic this
 * same call just created, which is trivially self-owned).
 *
 * Loud failure, in the same spirit as this repo's assertTestnet() and
 * preflightFacilitator(): a topic with no submit key, or one whose submit
 * key belongs to someone else, means an anchor written there would not
 * actually prove this agent wrote it -- silently proceeding would be
 * exactly the gap this function exists to close.
 */
export async function assertTopicOwnership(
  topicId: string,
  operatorPublicKey: PublicKey,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${MIRROR_NODE_URL}/api/v1/topics/${topicId}`);
  if (!response.ok) {
    throw new Error(
      `Refusing to anchor to topic ${topicId}: could not confirm ownership -- the mirror node ` +
        `returned ${response.status} for its topic info. Check the topic id.`,
    );
  }
  const info = (await response.json()) as Partial<MirrorTopicInfo>;
  const submitKey = info.submit_key;
  if (!submitKey) {
    throw new Error(
      `Refusing to anchor to topic ${topicId}: it has no submit key, so anyone could have ` +
        `written to it -- an anchor there would not prove this agent wrote it. Omit ` +
        `HCS_TOPIC_ID to create a fresh, properly-owned topic instead.`,
    );
  }
  const expected = operatorPublicKey.toStringRaw().toLowerCase();
  const actual = submitKey.key?.toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Refusing to anchor to topic ${topicId}: its submit key does not match this operator's ` +
        `key, so this agent does not control it -- an anchor there would not prove this agent ` +
        `wrote it.`,
    );
  }
}
