/**
 * HCS topic lifecycle. One topic holds every anchor for a demo account.
 */
import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Client } from "@hiero-ledger/sdk";
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

export async function createTopic(client: Client): Promise<string> {
  const response = await new TopicCreateTransaction()
    .setTopicMemo("hedera-proof-of-spend anchor")
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
