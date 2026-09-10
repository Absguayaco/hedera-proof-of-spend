import { describe, expect, it } from "vitest";
import { hashscanUrl, parseSettlement } from "./settlement.ts";

describe("parseSettlement", () => {
  it("parses a well-formed Hedera transaction id", () => {
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(settlement).toEqual({
      transactionId: "0.0.12345@1699999999.123456789",
      feePayer: "0.0.12345",
      validStartSeconds: 1699999999,
      validStartNanos: 123456789,
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
  it("builds the testnet transaction link with dashes, not the transaction id's dots", () => {
    // Verified live: https://hashscan.io/testnet/tx/<id> (dots, word "tx")
    // renders every field as "None". https://hashscan.io/testnet/transaction/
    // <dashed> (dashes, word "transaction") renders the real transaction.
    // Confirmed against a real settled testnet transaction.
    const settlement = parseSettlement("0.0.7162784@1788825896.303987758");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784-1788825896-303987758",
    );
  });

  it("does not dash-replace the dots inside the fee payer's account id", () => {
    // A naive transactionId.replaceAll(".", "-") would also mangle
    // "0.0.12345" into "0-0-12345". Building the URL from the already-parsed
    // fields avoids that.
    const settlement = parseSettlement("0.0.12345@1699999999.123456789");
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.12345-1699999999-123456789",
    );
  });

  it("keeps validStartNanos' significant leading zeros, rather than dropping them via Number()", () => {
    // Real testnet transaction, confirmed live: a naive Number()-then-
    // interpolate would produce .../0.0.7162784-1788825896-3987758 (7
    // digits, missing the two leading zeros) instead of the real 9-digit
    // nanos component below -- a link that 404s on HashScan.
    const settlement = parseSettlement("0.0.7162784@1788825896.003987758");
    expect(settlement.validStartNanos).toBe(3987758); // the correct number
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784-1788825896-003987758",
    );
  });

  it("pads an all-zero nanos component to the full 9 digits, the extreme case of the same bug", () => {
    const settlement = parseSettlement("0.0.7162784@1788825896.000000000");
    expect(settlement.validStartNanos).toBe(0);
    expect(hashscanUrl(settlement)).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784-1788825896-000000000",
    );
  });
});
