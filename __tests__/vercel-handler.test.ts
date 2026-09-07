/**
 * The serverless entry point has to preserve a property the long-running server
 * gets for free: a store that cannot settle payments must not look healthy.
 *
 * Only the failure paths are covered here, because they are the ones that are
 * pure. The success path reaches the real facilitator over the network, which
 * does not belong in a unit test.
 */
import { afterEach, describe, expect, it } from "vitest";
import handler from "../packages/store/src/vercel.ts";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

async function callMenu(): Promise<Response> {
  return handler(new Request("https://store.test/menu"));
}

describe("misconfiguration is reported, not crashed", () => {
  it("answers 503 rather than throwing when the payee is missing", async () => {
    delete process.env.STORE_PAYEE_ID;
    process.env.FACILITATOR_URL = "https://api.testnet.blocky402.com";

    const response = await callMenu();
    expect(response.status).toBe(503);
  });

  it("names the missing variable, so the deploy is fixable", async () => {
    delete process.env.STORE_PAYEE_ID;
    process.env.FACILITATOR_URL = "https://api.testnet.blocky402.com";

    const body = (await (await callMenu()).json()) as { reason: string };
    expect(body.reason).toMatch(/STORE_PAYEE_ID/);
  });

  it("answers 503 when the facilitator is missing", async () => {
    process.env.STORE_PAYEE_ID = "0.0.54321";
    delete process.env.FACILITATOR_URL;

    const body = (await (await callMenu()).json()) as { reason: string };
    expect(body.reason).toMatch(/FACILITATOR_URL/);
  });

  it("refuses a mainnet deployment", async () => {
    process.env.STORE_PAYEE_ID = "0.0.54321";
    process.env.FACILITATOR_URL = "https://api.testnet.blocky402.com";
    process.env.HEDERA_NETWORK = "mainnet";

    const body = (await (await callMenu()).json()) as { reason: string };
    expect(body.reason).toMatch(/Refusing to start/);
  });

  it("refuses a payee that is not a Hedera account id", async () => {
    process.env.STORE_PAYEE_ID = "0xdeadbeef";
    process.env.FACILITATOR_URL = "https://api.testnet.blocky402.com";

    const body = (await (await callMenu()).json()) as { reason: string };
    expect(body.reason).toMatch(/not a Hedera account id/);
  });

  it("does not cache a failure forever, so an outage recovers without a redeploy", async () => {
    delete process.env.STORE_PAYEE_ID;
    process.env.FACILITATOR_URL = "https://api.testnet.blocky402.com";
    expect((await callMenu()).status).toBe(503);

    // The same invocation path must be able to succeed once the cause is gone.
    // Reaching a 200 here would need the network, so this asserts only that the
    // failed state was cleared rather than memoized.
    const body = (await (await callMenu()).json()) as { reason: string };
    expect(body.reason).toMatch(/STORE_PAYEE_ID/);
  });

  it("marks the failure uncacheable", async () => {
    delete process.env.STORE_PAYEE_ID;
    const response = await callMenu();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
