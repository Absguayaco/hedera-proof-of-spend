import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { verify } from "./index.ts";

const RECEIPT = { rail: "hedera", amount: "15000000" };
const HASH = hashReceipt(RECEIPT);

function page(entries: Array<{ v: number; h: string }>, next: string | null = null): Response {
  const body = {
    messages: entries.map((entry, index) => ({
      message: Buffer.from(JSON.stringify(entry)).toString("base64"),
      consensus_timestamp: `170000000${index}.000000001`,
      sequence_number: index + 1,
    })),
    links: { next },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("verify", () => {
  it("reports a match when the topic carries the receipt's hash", async () => {
    const fetchImpl = (async () => page([{ v: 1, h: HASH }])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(result.computedHash).toBe(HASH);
    expect(result.consensusTimestamp).toBe("1700000000.000000001");
    expect(result.hashscanUrl).toBe("https://hashscan.io/testnet/topic/0.0.777/messages");
  });

  it("reports missing when the topic has messages but none match", async () => {
    const fetchImpl = (async () => page([{ v: 1, h: "0".repeat(64) }])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
    expect(result.consensusTimestamp).toBeUndefined();
  });

  it("reports missing when the topic has never received a message", async () => {
    const fetchImpl = (async () => page([])) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });

  it("follows pagination — a match on a later page is still found", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1
        ? page(
            [{ v: 1, h: "0".repeat(64) }],
            "/api/v1/topics/0.0.777/messages?sequencenumber=gt:1",
          )
        : page([{ v: 1, h: HASH }]);
    }) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("match");
    expect(call).toBe(2);
  });

  it("queries the testnet mirror node by default, and resolves a relative next link against it", async () => {
    const requested: string[] = [];
    let call = 0;
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      call += 1;
      return call === 1
        ? page([{ v: 1, h: "x" }], "/api/v1/topics/0.0.777/messages?sequencenumber=gt:1")
        : page([]);
    }) as typeof fetch;

    await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(requested[0]).toBe(
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.777/messages?limit=100",
    );
    expect(requested[1]).toBe(
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.777/messages?sequencenumber=gt:1",
    );
  });

  it("skips a malformed message instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            { message: "###not-valid-json###", consensus_timestamp: "1.1", sequence_number: 1 },
          ],
          links: { next: null },
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });

  it("surfaces a mirror node error rather than silently reporting missing", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    await expect(verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl)).rejects.toThrow(/500/);
  });
});
