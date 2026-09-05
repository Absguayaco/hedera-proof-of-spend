/**
 * HCS topic lifecycle. One topic holds every anchor for a demo account.
 */
import type { Client } from "@hiero-ledger/sdk";

/** The message written to the topic. Only the hash leaves the system — no
 *  amounts, no merchants, no line items, and no receipt id. A verifier finds
 *  its receipt by scanning for a matching hash, which is exactly the privacy
 *  property claimed: the topic alone tells an observer nothing. */
export interface AnchorMessage {
  readonly v: number;
  readonly h: string;
}

// TODO: implement — TopicCreateTransaction, returns the new topic id.
export async function createTopic(_client: Client): Promise<string> {
  throw new Error("not implemented");
}

// TODO: implement — TopicMessageSubmitTransaction with the JSON above.
export async function submitHash(
  _client: Client,
  _topicId: string,
  _hash: string,
): Promise<void> {
  throw new Error("not implemented");
}
