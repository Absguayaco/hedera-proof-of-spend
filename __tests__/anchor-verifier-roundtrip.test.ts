/**
 * Confirms what packages/anchor writes is what packages/verifier reads —
 * neither package's own test suite checks this, since each only tests its
 * own half of the wire format in isolation.
 *
 * Lives at the repository root, not inside either package, for the same
 * reason as hash-agreement.test.ts: importing both from here doesn't give
 * either package's manifest a dependency on the other.
 */
import { describe, expect, it } from "vitest";
import { encodeAnchorMessage } from "../packages/anchor/src/topic.ts";
import { hashReceipt as anchorHash } from "../packages/anchor/src/hash.ts";
import { verify } from "../packages/verifier/src/index.ts";

function fakeMirrorPage(topicMessageJson: string): Response {
  const body = {
    messages: [
      {
        message: Buffer.from(topicMessageJson).toString("base64"),
        consensus_timestamp: "1700000000.000000001",
        sequence_number: 1,
      },
    ],
    links: { next: null },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("what the anchor writes is what the verifier reads", () => {
  it("round-trips: encodeAnchorMessage -> mirror node -> verify() reports a match", async () => {
    const receipt = { rail: "hedera", amount: "15000000", item: { slug: "espresso" } };
    const hash = anchorHash(receipt);
    const wireMessage = encodeAnchorMessage(hash);

    const fetchImpl = (async () => fakeMirrorPage(wireMessage)) as typeof fetch;

    const result = await verify(receipt, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(result.computedHash).toBe(hash);
  });

  it("a tampered receipt does not match what was actually anchored", async () => {
    const original = { rail: "hedera", amount: "15000000" };
    const tampered = { rail: "hedera", amount: "15000001" };
    const wireMessage = encodeAnchorMessage(anchorHash(original));

    const fetchImpl = (async () => fakeMirrorPage(wireMessage)) as typeof fetch;

    const result = await verify(tampered, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });
});
