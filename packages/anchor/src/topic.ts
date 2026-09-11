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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same 6-attempts/5s-apart shape as packages/verifier/src/index.ts's
// fetchSettlementConsensusTimestamp() -- HCS consensus and the mirror
// node's REST API are separate systems (this repo's own prior work
// measured a real ~8.68s gap), so a topic anchorReceipt() just created a
// moment ago (the common case: e2e.ts anchors its decision, then reuses
// that same topicId for the decline and receipt anchors later in the same
// run) can genuinely 404 here before the mirror node has ingested it.
// Retried ONLY for that reason: a 404 means "can't confirm yet", not "not
// owned". "No submit key" and "key mismatch" are never transient -- a
// topic's submit key is set atomically at creation, so there is no lag
// window where a real submit key exists but hasn't shown up yet -- and
// both stay immediately fatal, no retry.
const OWNERSHIP_MAX_ATTEMPTS = 6;
const OWNERSHIP_RETRY_DELAY_MS = 5_000;

/** The fields this needs from GET /api/v1/topics/{id} -- confirmed live
 *  against a real topic: {"submit_key": null, "admin_key": null, ...} when
 *  unset, or {"submit_key": {"_type": "ECDSA_SECP256K1"|"ED25519", "key":
 *  "<hex>"}, ...} when set (confirmed live against a real account's key
 *  field, same shape). `key` is lowercase hex with no "0x" prefix --
 *  confirmed to match PublicKey.toStringRaw()'s own output format exactly. */
interface MirrorTopicInfo {
  readonly submit_key: { readonly _type: string; readonly key: string } | null;
  readonly admin_key: unknown;
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
 *
 * Also refuses a topic with an admin key. createTopic() above never sets
 * one, so a topic this project mints can never have its submit key changed
 * or cleared after the fact -- the "every message on an owned topic is
 * transitively guaranteed forever" argument this plan rests on depends on
 * that. A caller-supplied HCS_TOPIC_ID pointing at someone else's topic
 * could have an admin key, which would let that submit-key guarantee be
 * revoked retroactively for every message already anchored there --
 * refused here rather than silently trusted.
 *
 * Only supports a single-key submit key (ED25519 or ECDSA_SECP256K1). A
 * KeyList or ThresholdKey submit key reports as `_type: "ProtobufEncoded"`
 * on the mirror node and is refused, not decoded -- this check has no way
 * to confirm the operator's key is one of several signers.
 *
 * IMPORTANT, and the reason this alone is not "proof this agent anchored
 * it": this only establishes that `topicId` is owned by *someone* whose
 * key is `operatorPublicKey` -- the same key this call is signing with. It
 * says nothing about whether `topicId` is the topic a THIRD PARTY should
 * expect for a given claimed agent. See packages/verifier/src/cli.ts's
 * resolveTopicId() doc comment for what that means for a receipt-supplied
 * topic id specifically.
 */
export async function assertTopicOwnership(
  topicId: string,
  operatorPublicKey: PublicKey,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const url = `${MIRROR_NODE_URL}/api/v1/topics/${encodeURIComponent(topicId)}`;

  for (let attempt = 1; attempt <= OWNERSHIP_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(url);

    if (response.status === 404) {
      if (attempt < OWNERSHIP_MAX_ATTEMPTS) {
        await sleepImpl(OWNERSHIP_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(
        `Refusing to anchor to topic ${topicId}: the mirror node still returns 404 for it after ` +
          `retrying -- check the topic id.`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: could not confirm ownership -- the mirror node ` +
          `returned ${response.status} for its topic info. Check the topic id.`,
      );
    }

    const info = (await response.json()) as Partial<MirrorTopicInfo>;

    if (info.admin_key !== null && info.admin_key !== undefined) {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: it has an admin key, so its submit key could be ` +
          `changed or cleared later -- an anchor there today would not stay provably owned by ` +
          `this agent forever. Only anchor to a topic created by createTopic() (no admin key).`,
      );
    }

    const submitKey = info.submit_key;
    if (!submitKey) {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: it has no submit key, so anyone could have ` +
          `written to it -- an anchor there would not prove this agent wrote it. Omit ` +
          `HCS_TOPIC_ID to create a fresh, properly-owned topic instead.`,
      );
    }
    if (submitKey._type === "ProtobufEncoded") {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: its submit key is a multi-key (KeyList or ` +
          `ThresholdKey) structure -- this check only supports a single-key (ED25519 or ` +
          `ECDSA_SECP256K1) submit key.`,
      );
    }
    if (typeof submitKey.key !== "string") {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: its submit key has an unexpected shape from the ` +
          `mirror node.`,
      );
    }

    const expected = operatorPublicKey.toStringRaw().toLowerCase();
    const actual = submitKey.key.toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `Refusing to anchor to topic ${topicId}: its submit key does not match this operator's ` +
          `key, so this agent does not control it -- an anchor there would not prove this agent ` +
          `wrote it.`,
      );
    }
    return;
  }
}
