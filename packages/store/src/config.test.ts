import { describe, expect, it } from "vitest";
import { STORE_ASSET, STORE_NETWORK, readStoreConfig } from "./config.ts";

const valid = {
  STORE_PAYEE_ID: "0.0.54321",
  FACILITATOR_URL: "https://facilitator.blocky402.com",
} satisfies NodeJS.ProcessEnv;

describe("constants", () => {
  it("quotes hedera testnet", () => {
    expect(STORE_NETWORK).toBe("hedera:testnet");
  });

  it("quotes native HBAR rather than an HTS token", () => {
    // 0.0.0 is HBAR. Pricing in $ would resolve to the network's USD-pegged
    // default, which on Hedera is USDC — not what this project claims to do.
    expect(STORE_ASSET).toBe("0.0.0");
  });
});

describe("readStoreConfig", () => {
  it("reads a valid environment", () => {
    const config = readStoreConfig(valid);
    expect(config.payTo).toBe("0.0.54321");
    expect(config.port).toBe(8402);
  });

  it("refuses mainnet, so a misconfigured deploy cannot take real HBAR", () => {
    expect(() => readStoreConfig({ ...valid, HEDERA_NETWORK: "mainnet" })).toThrow(
      /Refusing to start/,
    );
  });

  it("refuses hedera:mainnet in CAIP-2 form too", () => {
    expect(() => readStoreConfig({ ...valid, HEDERA_NETWORK: "hedera:mainnet" })).toThrow(
      /Refusing to start/,
    );
  });

  it("accepts testnet in either spelling", () => {
    expect(() => readStoreConfig({ ...valid, HEDERA_NETWORK: "testnet" })).not.toThrow();
    expect(() => readStoreConfig({ ...valid, HEDERA_NETWORK: "hedera:testnet" })).not.toThrow();
  });

  it("checks the network before requiring anything else", () => {
    // A mainnet deploy that is also missing its payee must fail on mainnet,
    // not on the missing variable — otherwise fixing the variable reveals a
    // worse problem underneath.
    expect(() => readStoreConfig({ HEDERA_NETWORK: "mainnet" })).toThrow(/Refusing to start/);
  });

  it("requires the payee rather than guessing", () => {
    expect(() => readStoreConfig({ FACILITATOR_URL: valid.FACILITATOR_URL })).toThrow(
      /STORE_PAYEE_ID is not set/,
    );
  });

  it("treats a blank payee as missing", () => {
    expect(() => readStoreConfig({ ...valid, STORE_PAYEE_ID: "   " })).toThrow(
      /STORE_PAYEE_ID is not set/,
    );
  });

  it("rejects a payee that is not a Hedera account id", () => {
    expect(() => readStoreConfig({ ...valid, STORE_PAYEE_ID: "0xdeadbeef" })).toThrow(
      /not a Hedera account id/,
    );
  });

  it("requires a facilitator", () => {
    expect(() => readStoreConfig({ STORE_PAYEE_ID: valid.STORE_PAYEE_ID })).toThrow(
      /FACILITATOR_URL is not set/,
    );
  });

  it("refuses a plaintext facilitator, since verification is delegated to it", () => {
    expect(() =>
      readStoreConfig({ ...valid, FACILITATOR_URL: "http://facilitator.example.com" }),
    ).toThrow(/must be https/);
  });

  it("allows http on loopback, because that is how it is developed", () => {
    expect(() =>
      readStoreConfig({ ...valid, FACILITATOR_URL: "http://localhost:9000" }),
    ).not.toThrow();
  });

  it("rejects a malformed facilitator url", () => {
    expect(() => readStoreConfig({ ...valid, FACILITATOR_URL: "not a url" })).toThrow(
      /not a valid URL/,
    );
  });

  it("rejects an out-of-range port", () => {
    expect(() => readStoreConfig({ ...valid, PORT: "70000" })).toThrow(/not a valid port/);
  });

  it("rejects a non-numeric port instead of silently listening on 8402", () => {
    expect(() => readStoreConfig({ ...valid, PORT: "http" })).toThrow(/not a valid port/);
  });

  it("honours a valid port", () => {
    expect(readStoreConfig({ ...valid, PORT: "3000" }).port).toBe(3000);
  });
});
