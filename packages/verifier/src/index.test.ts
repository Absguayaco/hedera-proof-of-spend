import { describe, expect, it } from "vitest";
import { hashReceipt } from "./hash.ts";
import { fetchSettlementConsensusTimestamp, verify } from "./index.ts";

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
    expect(result.sequenceNumber).toBe(1);
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

  it("skips a message that decodes to JSON null instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              message: Buffer.from("null").toString("base64"),
              consensus_timestamp: "1.1",
              sequence_number: 1,
            },
          ],
          links: { next: null },
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl);

    expect(result.outcome).toBe("missing");
  });

  it("skips a message that decodes to a JSON array instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              message: Buffer.from("[1,2,3]").toString("base64"),
              consensus_timestamp: "1.1",
              sequence_number: 1,
            },
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

  it("throws a message naming the topic id when a 200 response isn't a messages page", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "not found" }), { status: 200 })) as typeof fetch;

    await expect(verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl)).rejects.toThrow(/0\.0\.777/);
  });

  it("throws that same shape error for an empty object body, instead of a raw TypeError", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    await expect(verify(RECEIPT, { topicId: "0.0.777" }, fetchImpl)).rejects.toThrow(
      /not a topic-messages page/,
    );
  });

  it('rejects a "network" value inherited from Object.prototype instead of bypassing the guard', async () => {
    const fetchImpl = (async () => page([])) as typeof fetch;

    await expect(
      verify(RECEIPT, { topicId: "0.0.1", network: "toString" }, fetchImpl),
    ).rejects.toThrow(/Unsupported network "toString"/);
  });
});

function transactionsPage(entries: Array<{ consensus_timestamp: string; result?: string }>): Response {
  const body = {
    transactions: entries.map((entry) => ({
      consensus_timestamp: entry.consensus_timestamp,
      result: entry.result ?? "SUCCESS",
    })),
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function notFound(): Response {
  return new Response(JSON.stringify({ _status: { messages: [{ message: "Not found" }] } }), {
    status: 404,
  });
}

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

describe("fetchSettlementConsensusTimestamp", () => {
  const TRANSACTION_ID = "0.0.7162784@1788825896.303987758";

  it("converts the @/dot transaction id to the mirror node's dash form and queries it", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return transactionsPage([{ consensus_timestamp: "1788825904.988176169" }]);
    }) as typeof fetch;

    await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(requested).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788825896-303987758",
    ]);
  });

  it("reports the real consensus timestamp on a first-attempt hit", async () => {
    const fetchImpl = (async () =>
      transactionsPage([{ consensus_timestamp: "1788825904.988176169" }])) as typeof fetch;

    const result = await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(result).toEqual({
      found: true,
      transactionId: TRANSACTION_ID,
      consensusTimestamp: "1788825904.988176169",
      result: "SUCCESS",
    });
  });

  it("retries on 404 (mirror-node ingestion lag), succeeding once the transaction appears", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 3 ? notFound() : transactionsPage([{ consensus_timestamp: "1788825904.988176169" }]);
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    const result = await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      {},
      fetchImpl,
      fakeSleep(sleepCalls),
    );

    expect(result.found).toBe(true);
    expect(call).toBe(3);
    expect(sleepCalls).toEqual([5_000, 5_000]);
  });

  it("treats a 200 response with an empty transactions array as not-yet-ingested and retries", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 2 ? transactionsPage([]) : transactionsPage([{ consensus_timestamp: "9.9" }]);
    }) as typeof fetch;

    const result = await fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([]));

    expect(result.found).toBe(true);
    expect(call).toBe(2);
  });

  it("reports not-found only after the retry budget (6 attempts) is exhausted", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return notFound();
    }) as typeof fetch;
    const sleepCalls: number[] = [];

    const result = await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      {},
      fetchImpl,
      fakeSleep(sleepCalls),
    );

    expect(result).toEqual({ found: false, transactionId: TRANSACTION_ID });
    expect(call).toBe(6);
    expect(sleepCalls).toHaveLength(5);
  });

  it("throws on a non-404 error status rather than silently reporting not-found", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/500/);
  });

  it("throws a message naming the transaction id when a 200 response isn't a transactions page", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 200 })) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(TRANSACTION_ID, {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(TRANSACTION_ID);
  });

  it("rejects a transaction id that isn't payer@seconds.nanos before ever calling fetch", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return transactionsPage([]);
    }) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp("not-a-transaction-id", {}, fetchImpl, fakeSleep([])),
    ).rejects.toThrow(/Not a Hedera transaction id/);
    expect(fetchCalled).toBe(false);
  });

  it("queries the testnet mirror node by default and mainnet when asked", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return transactionsPage([{ consensus_timestamp: "1.1" }]);
    }) as typeof fetch;

    await fetchSettlementConsensusTimestamp(
      TRANSACTION_ID,
      { network: "mainnet" },
      fetchImpl,
      fakeSleep([]),
    );

    expect(requested[0]).toBe(
      "https://mainnet-public.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788825896-303987758",
    );
  });

  it('rejects a "network" value inherited from Object.prototype instead of bypassing the guard', async () => {
    const fetchImpl = (async () => transactionsPage([])) as typeof fetch;

    await expect(
      fetchSettlementConsensusTimestamp(
        TRANSACTION_ID,
        { network: "toString" },
        fetchImpl,
        fakeSleep([]),
      ),
    ).rejects.toThrow(/Unsupported network "toString"/);
  });
});
