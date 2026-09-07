import { describe, expect, it } from "vitest";
import { hashscanUrl, parseSettlement } from "./settlement.ts";

describe("parseSettlement", () => {
  it("parses a well-formed Hedera transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(settlement).toEqual({
      transactionId: "0.0.12345@1699999999.123456789",
      feePayer: "0.0.12345",
      seconds: 1699999999,
      nanos: 123456789,
    });
  });

  it("rejects a reference with no @", () => {
    expect(() => parseSettlement("0.0.12345")).toThrow(/Not a Hedera transaction id/);
  });

  it("rejects a reference with non-numeric seconds", () => {
    expect(() => parseSettlement("0.0.12345@abc.123")).toThrow(/Not a Hedera transaction id/);
  });

  it("names the offending value, so the error is actionable", () => {
    expect(() => parseSettlement("not-a-tx-id")).toThrow(/"not-a-tx-id"/);
  });
});

describe("hashscanUrl", () => {
  it("builds the testnet transaction link from the full transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/tx/0.0.12345@1699999999.123456789",
    );
  });
});
